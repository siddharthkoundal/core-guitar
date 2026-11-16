# core-guitar RAG v2: Full-Stack Pipeline (pgvector, LangGraph, semantic chunking, eval)

> **What this document is:** a guide for you to implement yourself, as you asked
> ("give the code on side, I will implement on my own"). It is **not** a finished
> implementation. Nothing here has been committed to `siddharthkoundal/core-guitar` or
> run against it. The snippets were only checked to be valid Python. Treat each phase's
> tests as the acceptance criteria while you build it.

This builds on [`rag-v1-local-first-guide.md`](rag-v1-local-first-guide.md) (v1). v1 chose the smallest possible stack.
v2 deliberately uses the industry stack so you **learn and can show** each piece. One
rule from v1 still applies: **every component must earn its place with a number.** For
each tool, the eval harness either shows a gain or the README records why it was kept
or turned off. That turns "I listed tools" into "I evaluated tools".

Reused from v1 without change (do not rewrite them): `findings_ctx.py` (deterministic
findings selection), `verify.py` (citation, number and theory checks), the prompt
rules, the refusal gate, and the `coach.py` transport refactor.

---

## 0. Principal-engineer stance

1. **The core app stays zero-infrastructure.** `pip install -e .[app]` must still work
   with no Docker. All RAG features sit behind an optional `[rag]` extra and a running
   `docker compose` stack. The ask endpoint returns `503 rag_unavailable` with advice
   when Postgres is down. This avoids "my guitar analyser needs 4 containers".
2. **Local first, cloud opt-in.** Defaults are Ollama and local sentence-transformers.
   Groq and Gemini are wired in as providers so you can benchmark them, but they only
   run when `COREGUITAR_ALLOW_CLOUD=1`. Audio never leaves the machine.
3. **Learn each layer by owning it.** Hybrid retrieval is written in **SQL** (pgvector +
   Postgres full-text search) rather than hidden behind `vectorstore.similarity_search()`.
   LangChain is used for model interfaces and LangGraph for orchestration, which is
   where frameworks genuinely help.
4. **Ablate everything.** Chunking strategy × embedding model × retrieval mode × reranker
   × query transform. Report the table.
5. **Bounded agency.** The LangGraph flow has at most one corrective rewrite loop.
   No unbounded agents.

---

## 1. Stack and the reason for each piece

| Layer | Tool | Why it's here | What you learn / showcase | Alternative you can name |
|---|---|---|---|---|
| Vector + lexical store | **PostgreSQL 17 + pgvector 0.8** | One database for vectors, BM25-style FTS, metadata, JSONB filters and transactions; hybrid in one SQL statement | HNSW tuning (`m`, `ef_construction`, `ef_search`), `halfvec`, iterative scans with filters, partial expression indexes per model | Pinecone, Qdrant, Weaviate |
| Lexical search | Postgres `tsvector` + GIN + `ts_rank_cd` | Built in, transactional, and kept in sync with vectors for free | Text search configs, weighting (`setweight`), `websearch_to_tsquery` | ParadeDB `pg_search` (real BM25), Elasticsearch |
| Migrations | **Alembic** (SQLAlchemy Core) | Versioned schema, which reviewers expect | Reversible migrations, `CREATE INDEX CONCURRENTLY` | Raw SQL files |
| DB driver | **psycopg 3** async + `psycopg_pool` + `pgvector` adapter | Hot path in raw SQL for control and speed | Connection pooling, server-side params, binary vectors | asyncpg |
| Parsing | **PyMuPDF** (PDF), BeautifulSoup (HTML), `pyguitarpro` (GP) | Real loaders for real formats | Layout-aware extraction, cleaning | Docling, Unstructured |
| Chunking | Your own: **token sliding window, recursive structural, semantic (embedding breakpoints), parent-child, contextual headers** | Chunking is the biggest lever on RAG quality, so implement and compare | Tokenizer offsets, breakpoint thresholds, small-to-big retrieval | LangChain `SemanticChunker`, LlamaIndex node parsers |
| Embeddings | **nomic-embed-text-v1.5** (default), **BAAI/bge-m3**, **bge-small-en-v1.5**, opt-in **gemini-embedding-001** | Compare open models of different sizes against a cloud model | Task prefixes, Matryoshka truncation, normalisation, batching, caching | OpenAI `text-embedding-3-*` |
| Reranker | **bge-reranker-v2-m3** / bge-reranker-base (CrossEncoder) | Precision at the top of the ranking | Bi-encoder vs cross-encoder trade-off, latency budgets | Cohere Rerank, ColBERT |
| Query transforms | Multi-query, **HyDE**, step-back (LLM) | Recall on vague questions | When transforms help and when they cost more latency than they gain | — |
| Orchestration | **LangGraph** (+ `langchain-core`, `langchain-ollama`) | Explicit state machine: route → retrieve → grade → (rewrite) → generate → verify | Conditional edges, bounded loops, streaming events, checkpoints | LlamaIndex workflows, hand-written |
| LLMs | **Ollama** (llama3.2 / qwen2.5) default; **Groq**, **Gemini** opt-in | Provider-agnostic interface; benchmark quality and latency | Structured output (`with_structured_output`), provider swapping | LiteLLM, vLLM |
| API | **FastAPI** + **SSE** streaming | Progressive UX | Async endpoints, server-sent events | WebSockets |
| Cache + queue | **Redis 7** + **arq** | Exact answer cache; background ingestion of uploaded manuals | Idempotent jobs, retries | Celery, Postgres `SKIP LOCKED` |
| Semantic cache | pgvector table | Re-use answers for near-duplicate questions | **False-hit risk** (bar 5 vs bar 6) and how to guard it | GPTCache |
| Tracing | **OpenTelemetry** + **Arize Phoenix** (self-hosted) | See every node, prompt, token and retrieved chunk | OTel spans, OpenInference semantic conventions | Langfuse, LangSmith |
| Evaluation | Custom metrics + **RAGAS** + pytest + **testcontainers** | Retrieval and generation metrics; real-Postgres integration tests | LLM-as-judge calibration, ablation design, CI gates | DeepEval, TruLens |
| Tool interface | **MCP server** (official `mcp` SDK) | Use the RAG from Copilot or Claude Desktop; ties to your work experience | Tool schemas, stdio transport | — |
| UI | React panel with streaming and citation playback | Demo | — | — |

**What not to add** (and why you can say so in an interview): a second vector database
(Postgres already covers it), LlamaIndex as well as LangChain (two frameworks doing the
same job), Kubernetes (single-user local app), fine-tuning (no labelled data at that
scale yet).

---

## 2. Architecture

```text
INGESTION (CLI `coreguitar rag ingest` or arq worker on upload)
 sources/ ─► loaders (md | html | pdf | gp) ─► clean + normalise ─► dedupe (sha256)
          ─► structure (sections, breadcrumbs)
          ─► chunkers ── sliding_window(256/64 tok)
                      ├─ recursive(heading→para→sentence, ≤400 tok)
                      ├─ semantic(sentence embeddings, percentile breakpoints)
                      └─ parent_child(parent ≤1024 tok, child 128/32 tok)
          ─► [optional] contextual header per chunk (LLM, cached by sha)
          ─► embed (per model; batched; cache by (model, sha))
          ─► Postgres: sources, documents, chunks(tsv generated), chunk_embeddings(vector)
                       + HNSW partial index per model, GIN on tsv and meta

QUERY (LangGraph, POST /api/.../ask  → SSE)
 route ──► take question?  load analysis + findings_ctx (deterministic, v1)
   │       theory?         flag theory verifier
   │       tone / riffs?   metadata filters
   ▼
 transform (optional: multi-query | HyDE | step-back)
   ▼
 retrieve: ONE SQL statement → dense(HNSW) ∥ lexical(tsvector) ∥ tags(jsonb) → RRF
   ▼
 rerank (cross-encoder, timeout) → MMR diversity → parent expansion (small-to-big)
   ▼
 grade: top rerank score ≥ τ ?  ── no, attempts<1 ─► rewrite query ─► retrieve
   │                            └─ no, attempts=1 ─► refuse (no LLM call)
   ▼ yes
 generate (structured output: answer, citations, refused)
   ▼
 verify (v1: citations, numbers, theory) ─► fallback if uncited
   ▼
 SSE: progress events … final verified answer + citations + timings + trace_id
```

---

## 3. Master prompt (v2)

```text
You are a principal engineer adding a production-grade RAG pipeline to core-guitar
(Python 3.10+, FastAPI on 127.0.0.1, React/TS, Ollama local LLMs).

Stack (all optional behind the [rag] extra; core app must still run without Docker):
PostgreSQL 17 + pgvector 0.8 (HNSW, partial expression index per embedding model,
iterative scans), Postgres full-text search (tsvector + GIN), Alembic migrations,
psycopg 3 async pool, sentence-transformers + Ollama embeddings (nomic-embed-text-v1.5
default; bge-m3, bge-small-en-v1.5; gemini-embedding-001 opt-in), CrossEncoder reranker
(bge-reranker-v2-m3), LangGraph orchestration with langchain-ollama (Groq/Gemini opt-in
behind COREGUITAR_ALLOW_CLOUD=1), Redis + arq for ingestion jobs and exact cache,
OpenTelemetry + Arize Phoenix tracing, RAGAS + custom metrics, testcontainers for
integration tests, an MCP server exposing search and ask tools.

Pipeline requirements:
- Loaders: markdown, HTML, PDF (PyMuPDF), Guitar Pro (pyguitarpro -> text summary).
  Every source carries license + attribution; refuse to ingest without them.
- Chunkers (all implemented, selectable, stored side by side via chunks.strategy):
  token sliding window using the embedding model's tokenizer offsets; recursive
  structural; semantic chunking via sentence-window embeddings and percentile
  breakpoints with min/max token bounds; parent-child (small-to-big); optional
  LLM contextual headers cached by content hash.
- Embeddings: model registry with dims, max tokens, query/document prefixes;
  batched; L2-normalised; cached in Postgres by (model, sha256).
- Retrieval: one SQL statement fusing dense (HNSW), lexical (ts_rank_cd) and
  finding-type tag rankers with Reciprocal Rank Fusion; metadata filters; then
  CrossEncoder rerank (timeout fallback), MMR, parent expansion.
- Generation: LangGraph route -> transform -> retrieve -> grade -> (one rewrite) ->
  generate (structured output) -> verify. Reuse v1 findings_ctx and verify modules.
  Refuse without calling the LLM when grading fails twice.
- Serving: FastAPI SSE (progress events + final verified answer), exact cache in
  Redis, semantic cache in pgvector guarded against numeric-entity mismatch.
- Observability: OTel spans for every node and SQL query, exported to Phoenix.
- Eval: retrieval (Recall@k, MRR, nDCG) and generation (faithfulness, context
  precision/recall, citation precision, refusal accuracy, latency p50/p95) across an
  ablation matrix; HNSW vs exact benchmark; deterministic CI gate with
  testcontainers Postgres and bge-small.
Constraints: no scraping of tab/lyric sites; no secrets in code; all ports bound to
127.0.0.1; every new module has unit tests; one phase per commit; match repo style.
```

---

## 4. Layout

```text
docker-compose.rag.yml
alembic.ini
migrations/versions/0001_rag_schema.py
sources/                       # committed: original + CC-licensed material only
  notes/*.md                   # your own drills/theory notes
  manifests/*.yaml             # remote sources to fetch (Wikibooks, Open Music Theory)
data/rag/private/              # git-ignored: your GP files, amp/pedal manuals (PDF)
src/coreguitar/rag/
  settings.py                  # pydantic-settings (env-driven)
  db.py                        # async pool, vector registration, index management
  loaders/{markdown,html,pdf,guitarpro}.py
  text.py                      # cleaning, sentence split, lexical normalisation
  chunking/{base,sliding,recursive,semantic,parent_child,contextual}.py
  embeddings/{registry,providers,cache}.py
  ingest.py                    # pipeline + arq tasks
  retrieval/{hybrid_sql,rerank,mmr,transforms}.py
  graph/{state,nodes,build}.py # LangGraph
  llm.py                       # provider factory (ollama | groq | gemini)
  cache.py                     # exact (redis) + semantic (pgvector)
  tracing.py                   # OTel + Phoenix
  findings_ctx.py, verify.py   # from v1
  mcp_server.py
  eval/{datasets,metrics,ragas_eval,ablate,hnsw_bench}.py
tests/rag/{unit,integration}/
```

---

## 5. Phase 1: Infrastructure

**Why:** a reproducible local stack you can bring up with one command. All ports bind
to `127.0.0.1`, which keeps the repo's loopback-only security stance.

```yaml
# docker-compose.rag.yml
services:
  db:
    image: pgvector/pgvector:0.8.0-pg17
    environment:
      POSTGRES_USER: coreguitar
      POSTGRES_PASSWORD: ${COREGUITAR_PG_PASSWORD:?set in .env}
      POSTGRES_DB: coreguitar
    ports: ["127.0.0.1:5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    command: >
      postgres -c shared_buffers=512MB -c maintenance_work_mem=1GB
               -c max_parallel_maintenance_workers=4 -c effective_cache_size=2GB
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U coreguitar"]
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ["127.0.0.1:6379:6379"]
    command: ["redis-server", "--save", "", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
  phoenix:
    image: arizephoenix/phoenix:latest
    ports: ["127.0.0.1:6006:6006", "127.0.0.1:4317:4317"]
volumes:
  pgdata:
```

`maintenance_work_mem` matters: an HNSW build that does not fit in it becomes much
slower (pgvector logs a notice). Pin `phoenix` to a specific version once you have it
working.

```toml
# pyproject.toml additions
[project.optional-dependencies]
rag = [
  "psycopg[binary,pool]>=3.2", "pgvector>=0.3", "sqlalchemy>=2.0", "alembic>=1.13",
  "pydantic-settings>=2.4",
  "sentence-transformers>=3.0", "transformers>=4.44", "numpy",
  "langchain-core>=0.3", "langchain-ollama>=0.2", "langgraph>=0.2",
  "redis>=5", "arq>=0.26",
  "pymupdf>=1.24", "beautifulsoup4>=4.12", "pysbd>=0.3",
  "opentelemetry-sdk", "arize-phoenix-otel", "openinference-instrumentation-langchain",
  "mcp>=1.2", "sse-starlette>=2.1",
]
rag-cloud = ["langchain-groq>=0.2", "langchain-google-genai>=2.0", "google-genai>=1.0"]
rag-eval = ["ragas>=0.2", "testcontainers[postgres]>=4.8", "datasets"]
```

Pin exact versions in a lock file (`uv lock`) once it works. RAGAS and LangChain
change their APIs often.

```python
# rag/settings.py
from __future__ import annotations

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class RagSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COREGUITAR_", env_file=".env", extra="ignore")

    pg_dsn: SecretStr = SecretStr("postgresql://coreguitar:coreguitar@127.0.0.1:5432/coreguitar")
    redis_url: str = "redis://127.0.0.1:6379/0"
    phoenix_endpoint: str = "http://127.0.0.1:6006/v1/traces"
    allow_cloud: bool = False

    embed_model: str = "nomic-embed-text-v1.5"
    chunk_strategy: str = "semantic"
    chat_provider: str = "ollama"            # ollama | groq | gemini
    chat_model: str = "llama3.2"

    k_dense: int = 40
    k_lexical: int = 40
    k_tags: int = 20
    rrf_k: int = 60
    k_rerank_in: int = 24
    k_final: int = 6
    use_rerank: bool = True
    reranker: str = "BAAI/bge-reranker-v2-m3"
    rerank_timeout_s: float = 2.5
    grade_threshold: float = 0.15            # sigmoid rerank score; calibrate in eval
    mmr_lambda: float = 0.7
    ef_search: int = 80
    query_transform: str = "none"            # none | multi | hyde | stepback
    max_evidence_tokens: int = 2000
```

---
## 6. Phase 2: Schema (Alembic + pgvector)

**Design decisions:**
- **`chunks` and `chunk_embeddings` are separate tables.** One chunk can have
  embeddings from several models (needed for the ablation) without duplicating text.
- **The `embedding` column has no fixed dimension, plus a partial expression index per
  model.** pgvector allows `vector` without a dimension and an index on
  `(embedding::vector(768))` restricted with `WHERE model = '…'`. This is the standard
  pgvector pattern for mixed dimensions. Queries **must** repeat the same cast and
  `WHERE model = …`, or the planner will not use the index.
- **`halfvec` index option:** indexing `embedding::halfvec(768)` halves the index size
  with negligible recall loss. Benchmark it in the HNSW study (§13.4).
- **`tsv` is a generated column** built from `lexical_text`, which is normalised in
  Python (`C#` → `csharp`, `TS-9` → `ts9`). Postgres's parser would otherwise split `#`.
  A generated column can never drift out of sync with the text.
- **`strategy` is a column**, so all chunking strategies coexist and the eval compares
  them on the same documents.
- **`parent_id`** links child chunks to parent chunks for small-to-big retrieval.
- **License and attribution are `NOT NULL` on `sources`**, so provenance is enforced by
  the schema, not just by convention.

```python
# migrations/versions/0001_rag_schema.py
"""rag schema"""
from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("""
    CREATE TABLE sources (
      id           text PRIMARY KEY,
      kind         text NOT NULL CHECK (kind IN ('markdown','html','pdf','guitarpro')),
      uri          text NOT NULL,
      title        text NOT NULL,
      license      text NOT NULL,
      attribution  text NOT NULL,
      private      boolean NOT NULL DEFAULT false,     -- never exported / never sent to cloud
      sha256       text NOT NULL,
      ingested_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE documents (
      id         bigserial PRIMARY KEY,
      source_id  text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      title      text NOT NULL,
      meta       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- topic, level, finding_types, tuning, bpm, key...
      sha256     text NOT NULL,
      UNIQUE (source_id, sha256)
    );
    CREATE TABLE chunks (
      id            bigserial PRIMARY KEY,
      document_id   bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      strategy      text NOT NULL,                     -- sliding | recursive | semantic | parent | child
      parent_id     bigint REFERENCES chunks(id) ON DELETE CASCADE,
      ord           int NOT NULL,
      section_path  text[] NOT NULL DEFAULT '{}',
      text          text NOT NULL,
      context       text,                              -- contextual header (optional)
      lexical_text  text NOT NULL,                     -- normalised for FTS
      token_count   int NOT NULL,
      meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
      sha256        text NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', lexical_text)) STORED,
      UNIQUE (document_id, strategy, ord)
    );
    CREATE INDEX chunks_tsv_gin     ON chunks USING gin (tsv);
    CREATE INDEX chunks_meta_gin    ON chunks USING gin (meta);
    CREATE INDEX chunks_strategy    ON chunks (strategy);
    CREATE INDEX chunks_parent      ON chunks (parent_id);

    CREATE TABLE chunk_embeddings (
      chunk_id   bigint NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      model      text   NOT NULL,
      strategy   text   NOT NULL,                      -- denormalised: filter without a join
      embedding  vector NOT NULL,
      PRIMARY KEY (chunk_id, model)
    );
    CREATE TABLE embedding_cache (
      model     text NOT NULL,
      sha256    text NOT NULL,
      embedding vector NOT NULL,
      PRIMARY KEY (model, sha256)
    );
    CREATE TABLE context_cache (
      sha256 text NOT NULL, llm text NOT NULL, context text NOT NULL,
      PRIMARY KEY (sha256, llm)
    );
    CREATE TABLE semantic_cache (
      id            bigserial PRIMARY KEY,
      scope         text NOT NULL,                     -- analysis_id or 'library'
      index_version text NOT NULL,
      model         text NOT NULL,
      question      text NOT NULL,
      entities      text[] NOT NULL,                   -- numbers/bars/chords in the question
      embedding     vector NOT NULL,
      answer        jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX semantic_cache_scope ON semantic_cache (scope, index_version, model);
    CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
    """)


def downgrade() -> None:
    op.execute("""DROP TABLE IF EXISTS meta, semantic_cache, context_cache, embedding_cache,
                  chunk_embeddings, chunks, documents, sources CASCADE""")
```

Vector indexes are **not** in the migration. They depend on which models you
register, so `db.ensure_vector_index()` creates them after ingestion (§8.3). Building
HNSW after a bulk load is several times faster than inserting into an existing index.

---

## 7. Phase 3: Ingestion (loaders, cleaning, chunking)

### 7.1 Corpus and licensing (decide this first)

| Source | License | Committed? | What it gives you |
|---|---|---|---|
| Your own notes (`sources/notes/*.md`) | Yours (CC-BY-4.0) | Yes | Drills per finding type, practice method |
| **Wikibooks: Guitar** | CC BY-SA 4.0 | Manifest only (fetch at ingest) | Technique, chords, scales, gear basics; hundreds of pages, enough to make chunking and HNSW meaningful |
| **Open Music Theory** | CC BY-SA 4.0 | Manifest only | Rigorous theory for the theory verifier's domain |
| Your Guitar Pro files | Varies | **No** (`data/rag/private`) | Riff library search by tuning, BPM, key, technique |
| Your amp/pedal manuals (PDF) | Manufacturer copyright | **No**, local use only | Tone settings grounded in real manuals; the strongest "tone" feature |
| Mutopia / IMSLP public-domain scores | Public domain / CC | Optional | Classical guitar material |
| Tab sites, lyrics, forums | ToS / copyright | **Never** | Link out only |

Private sources are flagged `private=true`. They are excluded from any export and
**never sent to cloud models**, even when `allow_cloud` is on. That is a nice privacy
detail to mention in interviews.

```yaml
# sources/manifests/wikibooks-guitar.yaml
id: wikibooks-guitar
kind: html
license: CC BY-SA 4.0
attribution: "Wikibooks contributors, Guitar, https://en.wikibooks.org/wiki/Guitar"
fetch:
  api: https://en.wikibooks.org/w/api.php     # MediaWiki API, polite rate (1 req/s), User-Agent set
  prefix: "Guitar/"
meta: { topic_from_title: true }
```

Use the MediaWiki API (`action=parse&prop=text`), not HTML scraping. Cache the raw
responses under `data/rag/raw/`, so re-ingest never re-fetches.

### 7.2 Loader contract

```python
# rag/loaders/base.py
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Section:
    path: tuple[str, ...]          # heading breadcrumb, e.g. ("Barre chords", "Practice")
    text: str
    meta: dict = field(default_factory=dict)   # e.g. {"page": 12} for PDFs


@dataclass(frozen=True)
class LoadedDoc:
    source_id: str
    title: str
    sections: tuple[Section, ...]
    meta: dict                     # topic, level, finding_types, tuning, bpm, key...
```

```python
# rag/loaders/pdf.py - font-size heuristic for headings, page numbers kept for citations
from __future__ import annotations

import statistics

import fitz  # PyMuPDF

from .base import LoadedDoc, Section


def load_pdf(path, source_id: str, title: str) -> LoadedDoc:
    doc = fitz.open(path)
    spans = [(s["size"], s["text"].strip(), pno + 1)
             for pno, page in enumerate(doc)
             for b in page.get_text("dict")["blocks"] if b.get("type") == 0
             for line in b["lines"] for s in line["spans"] if s["text"].strip()]
    if not spans:
        return LoadedDoc(source_id, title, (), {})
    body = statistics.median(s for s, _, _ in spans)
    sections: list[Section] = []
    heading, buf, page = (title,), [], 1
    for size, text, pno in spans:
        if size >= body * 1.25 and len(text) < 120:          # heading
            if buf:
                sections.append(Section(heading, " ".join(buf), {"page": page}))
            heading, buf, page = (title, text), [], pno
        else:
            buf.append(text)
    if buf:
        sections.append(Section(heading, " ".join(buf), {"page": page}))
    return LoadedDoc(source_id, title, tuple(sections), {"kind": "manual"})
```

```python
# rag/loaders/guitarpro.py - a GP file becomes a searchable text card + structured meta
from __future__ import annotations

from collections import Counter

import guitarpro

from ...music import midi_to_name
from .base import LoadedDoc, Section


def load_gp(path, source_id: str) -> LoadedDoc:
    song = guitarpro.parse(str(path))
    sections = []
    for track in song.tracks:
        if track.isPercussionTrack:
            continue
        tuning = " ".join(midi_to_name(s.value)[:-1] for s in reversed(track.strings))
        fx = Counter()
        pcs = Counter()
        for measure in track.measures:
            for voice in measure.voices:
                for beat in voice.beats:
                    for note in beat.notes:
                        e = note.effect
                        fx["palm_mute"] += e.palmMute
                        fx["bend"] += e.bend is not None
                        fx["slide"] += bool(e.slides)
                        fx["hammer_pull"] += e.hammer
                        pcs[(track.strings[note.string - 1].value + note.value) % 12] += 1
        sig = song.measureHeaders[0].timeSignature
        techniques = ", ".join(k for k, v in fx.most_common() if v)
        text = (f"{song.title or path.stem} by {song.artist or 'unknown'}: track "
                f"{track.name}, tuning {tuning}, {song.tempo} BPM, "
                f"{sig.numerator}/{sig.denominator.value}, {len(track.measures)} bars. "
                f"Techniques: {techniques or 'none detected'}.")
        sections.append(Section((track.name,), text,
                                {"tuning": tuning, "bpm": song.tempo,
                                 "techniques": [k for k, v in fx.items() if v],
                                 "pitch_classes": dict(pcs)}))
    return LoadedDoc(source_id, song.title or path.stem, tuple(sections),
                     {"kind": "riff", "artist": song.artist})
```

Estimate the key from `pitch_classes` with a Krumhansl-Schmuckler correlation (about
25 lines of numpy) and store it in `documents.meta.key`. A query such as "drop D riffs
around 140 BPM in E minor" then becomes **metadata filters plus text retrieval**
(self-query retrieval, §9.5).

### 7.3 Text utilities

```python
# rag/text.py
from __future__ import annotations

import re
import unicodedata

import pysbd

_SEG = pysbd.Segmenter(language="en", clean=False)
_SYM = str.maketrans({"♭": "b", "♯": "#", "–": "-", "—": "-", "’": "'", "\u00a0": " "})
_LEX = [(re.compile(p, re.I), r) for p, r in (
    (r"\b([a-g])#", r"\1sharp"),                 # C# -> csharp, F#m7 -> fsharpm7
    (r"\b([a-g])b(?=m|maj|dim|aug|\d|\b)", r"\1flat"),
    (r"\btube\s*screamer\b|\bts-?9\b", "ts9"),
    (r"\bdrop[\s-]?d\b", "dropd"),
    (r"\b3\s*nps\b|\bthree[\s-]notes?[\s-]per[\s-]string\b", "3nps"),
    (r"\bhalf[\s-]?diminished\b|\bm7\s*\(?b5\)?", "m7b5"),
    (r"\bpalm[\s-]?mut\w*", "palmmute"),
)]


def clean(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_SYM)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def lexical(text: str) -> str:
    """Normalisation applied identically to indexed text and to queries."""
    for pattern, repl in _LEX:
        text = pattern.sub(repl, text)
    return text.lower()


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SEG.segment(text) if s.strip()]
```

`pysbd` handles abbreviations such as "approx.", "e.g." and "No. 5" much better than
regex splitting. Bad sentence boundaries directly damage semantic chunking.

### 7.4 Chunkers

All chunkers share one interface, and the ingest pipeline runs every configured
strategy on every document.

```python
# rag/chunking/base.py
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from ..loaders.base import LoadedDoc


@dataclass
class ChunkDraft:
    text: str
    section_path: tuple[str, ...]
    token_count: int
    meta: dict = field(default_factory=dict)
    parent_ord: int | None = None      # index into the parent list (parent_child only)


class Chunker(Protocol):
    name: str
    def chunk(self, doc: LoadedDoc) -> list[ChunkDraft]: ...
```

#### (a) Token sliding window: the baseline

**What:** fixed windows of N tokens with overlap O, stride N − O.

**Why:**
- It is the baseline every other strategy has to beat.
- Overlap means a fact that straddles a boundary appears whole in at least one chunk.
- **Count tokens with the embedding model's own tokenizer**, not characters or
  whitespace. Otherwise you silently exceed `max_tokens` (bge-small is 512) and the
  model truncates the end of the chunk.
- Slice the **original text** using the tokenizer's offset mapping. Decoding token IDs
  loses casing, spacing and symbols.
- Windows stay inside a section, so a chunk never mixes two topics.

```python
# rag/chunking/sliding.py
from __future__ import annotations

from transformers import PreTrainedTokenizerFast

from .base import ChunkDraft


class SlidingWindow:
    name = "sliding"

    def __init__(self, tokenizer: PreTrainedTokenizerFast, size: int = 256, overlap: int = 64):
        if not 0 <= overlap < size:
            raise ValueError("need 0 <= overlap < size")
        self.tok, self.size, self.step = tokenizer, size, size - overlap

    def chunk(self, doc) -> list[ChunkDraft]:
        out: list[ChunkDraft] = []
        for sec in doc.sections:
            enc = self.tok(sec.text, add_special_tokens=False, return_offsets_mapping=True)
            offsets = enc["offset_mapping"]
            n = len(offsets)
            if n == 0:
                continue
            start = 0
            while True:
                end = min(start + self.size, n)
                a, b = offsets[start][0], offsets[end - 1][1]
                out.append(ChunkDraft(sec.text[a:b], sec.path, end - start, dict(sec.meta)))
                if end == n:
                    break
                start += self.step
        return out
```

Sweep `size ∈ {128, 256, 512}` × `overlap ∈ {0, 32, 64, 128}` in the ablation. Overlap
improves recall but inflates the index by roughly `size / stride`. Report both effects.

#### (b) Recursive structural

**What:** split on headings first, then paragraphs, then sentences, and only fall back
to a smaller unit when a piece is longer than `max_tokens`. Small neighbouring pieces
are merged up to the target size.

**Why:** authors already marked the topic boundaries with headings. This is the strong
"cheap" baseline, and it is what LangChain's `RecursiveCharacterTextSplitter`
approximates with characters.

```python
# rag/chunking/recursive.py
from __future__ import annotations

import re

from ..text import sentences
from .base import ChunkDraft


class Recursive:
    name = "recursive"

    def __init__(self, count_tokens, target: int = 320, max_tokens: int = 400):
        self.count, self.target, self.max = count_tokens, target, max_tokens

    def _pieces(self, text: str) -> list[str]:
        if self.count(text) <= self.max:
            return [text]
        paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
        if len(paras) > 1:
            return [x for p in paras for x in self._pieces(p)]
        return sentences(text)          # last level; a single huge sentence stays whole

    def chunk(self, doc) -> list[ChunkDraft]:
        out: list[ChunkDraft] = []
        for sec in doc.sections:
            buf, size = [], 0
            for piece in self._pieces(sec.text):
                n = self.count(piece)
                if buf and size + n > self.target:
                    out.append(ChunkDraft(" ".join(buf), sec.path, size, dict(sec.meta)))
                    buf, size = [], 0
                buf.append(piece)
                size += n
            if buf:
                out.append(ChunkDraft(" ".join(buf), sec.path, size, dict(sec.meta)))
        return out
```

#### (c) Semantic chunking (embedding breakpoints)

**What:** embed each sentence together with its neighbours (a sliding *sentence*
window), measure the cosine distance between consecutive windows, and cut where the
distance is unusually high: above the Pth percentile within the document. Minimum and
maximum token bounds apply.

**Why:**
- Topic shifts inside long sections (common in Wikibooks pages and manuals) don't
  always have headings. Semantic breakpoints find them.
- **Windowed** sentence embeddings (buffer = 1) smooth out noise from short sentences
  such as "Repeat." that would otherwise trigger false breakpoints.
- **Per-document percentile thresholds** adapt to each document's writing style. A
  fixed global threshold over-splits dense theory pages and under-splits chatty ones.
- **Bounds are required.** Without `min_tokens`, you get one-sentence chunks that
  embed poorly. Without `max_tokens`, you exceed the embedding model's context.

**Cost:** one embedding per sentence at ingest, so 5–10× more embedding calls than
chunk-level embedding. Use a **fast model for breakpoints** (bge-small, 384 dimensions)
even when the index uses a larger model. Breakpoint detection only needs relative
distances. Measure the ingest time and report it in the ablation.

```python
# rag/chunking/semantic.py
from __future__ import annotations

from collections.abc import Callable

import numpy as np

from ..text import sentences
from .base import ChunkDraft

EmbedFn = Callable[[list[str]], np.ndarray]     # returns L2-normalised rows


class Semantic:
    name = "semantic"

    def __init__(self, embed: EmbedFn, count_tokens, *, buffer: int = 1,
                 percentile: float = 90.0, min_tokens: int = 80, max_tokens: int = 400):
        self.embed, self.count = embed, count_tokens
        self.buffer, self.pct = buffer, percentile
        self.min, self.max = min_tokens, max_tokens

    def chunk(self, doc) -> list[ChunkDraft]:
        out: list[ChunkDraft] = []
        for sec in doc.sections:
            sents = sentences(sec.text)
            if len(sents) <= 2:
                if sents:
                    out.append(ChunkDraft(" ".join(sents), sec.path,
                                          self.count(sec.text), dict(sec.meta)))
                continue
            n, b = len(sents), self.buffer
            windows = [" ".join(sents[max(0, i - b): i + b + 1]) for i in range(n)]
            emb = self.embed(windows)
            dist = 1.0 - np.einsum("ij,ij->i", emb[:-1], emb[1:])   # distance i -> i+1
            threshold = float(np.percentile(dist, self.pct))
            tokens = [self.count(s) for s in sents]

            buf, size = [sents[0]], tokens[0]
            for i in range(1, n):
                semantic_break = dist[i - 1] >= threshold and size >= self.min
                hard_break = size + tokens[i] > self.max
                if semantic_break or hard_break:
                    out.append(ChunkDraft(" ".join(buf), sec.path, size,
                                          {**sec.meta, "break": "semantic" if semantic_break else "max"}))
                    buf, size = [], 0
                buf.append(sents[i])
                size += tokens[i]
            if buf:
                if out and size < self.min and out[-1].section_path == sec.path \
                        and out[-1].token_count + size <= self.max:
                    last = out.pop()                                  # merge short tail
                    out.append(ChunkDraft(last.text + " " + " ".join(buf), sec.path,
                                          last.token_count + size, last.meta))
                else:
                    out.append(ChunkDraft(" ".join(buf), sec.path, size, dict(sec.meta)))
        return out
```

Tune `percentile ∈ {80, 90, 95}` in the ablation. Log the `break` reason counts: if most
breaks are `max`, the semantic signal isn't doing anything for your corpus. That is a
real finding to report either way.

#### (d) Parent-child (small-to-big)

**What:** index small child chunks (128 tokens, sliding with 32 overlap) for precise
matching, and give the LLM the larger **parent** (structural section, up to 1,024
tokens) they belong to.

**Why:** small chunks embed one idea each, so they match precisely. Large chunks give
the LLM enough context to give good advice. This resolves the classic chunk-size
trade-off instead of compromising on it. Parents are deduplicated, so three matching
children from one section cost one parent slot in the prompt.

```python
# rag/chunking/parent_child.py
from __future__ import annotations

from .base import ChunkDraft
from .recursive import Recursive
from .sliding import SlidingWindow


class ParentChild:
    name = "parent_child"

    def __init__(self, tokenizer, count_tokens, parent_tokens=1024, child=128, overlap=32):
        self.parents = Recursive(count_tokens, target=parent_tokens, max_tokens=parent_tokens)
        self.children = SlidingWindow(tokenizer, child, overlap)

    def chunk(self, doc) -> list[ChunkDraft]:
        from ..loaders.base import LoadedDoc, Section
        out: list[ChunkDraft] = []
        for p_index, parent in enumerate(self.parents.chunk(doc)):
            out.append(ChunkDraft(parent.text, parent.section_path, parent.token_count,
                                  {**parent.meta, "role": "parent"}))
            p_ord = len(out) - 1
            sub = LoadedDoc(doc.source_id, doc.title,
                            (Section(parent.section_path, parent.text, parent.meta),), doc.meta)
            for child in self.children.chunk(sub):
                child.meta["role"] = "child"
                child.parent_ord = p_ord
                out.append(child)
        return out
```

When stored, parents get `strategy='parent'` (with **no embedding**: they are never
searched directly) and children get `strategy='child'` with `parent_id` set.

#### (e) Contextual chunk headers (optional, LLM)

**What:** at ingest, an LLM writes one or two sentences placing each chunk within its
document ("This section of the Wikibooks barre-chord page explains thumb position for
the F major shape…"). The header is prepended to the text that gets **embedded and
indexed for BM25**; the LLM still sees the original chunk.

**Why:** chunks lose their context when cut out of a document ("Keep it relaxed" — keep
*what* relaxed?). Anthropic's "contextual retrieval" write-up reports large drops in
retrieval failures from this. Your ablation tests whether that holds on your corpus.

**Cost:** one LLM call per chunk. Cache it by `sha256(doc_sha + chunk_text)` in
`context_cache`. Run it locally overnight with `llama3.2`; never send private sources
to the cloud.

```python
# rag/chunking/contextual.py
PROMPT = """<document_title>{title}</document_title>
<section>{path}</section>
<chunk>{chunk}</chunk>
Write 1-2 sentences that situate this chunk within the document for search retrieval.
Mention the topic and any guitar-specific terms it relates to. Reply with the sentences only."""


async def contextualise(llm, title: str, path: tuple[str, ...], chunk: str) -> str:
    msg = await llm.ainvoke(PROMPT.format(title=title, path=" > ".join(path), chunk=chunk[:2000]))
    return " ".join(str(msg.content).split())[:400]
```

The cheap fallback with no LLM is a breadcrumb header (`title > section > subsection`),
as in v1. **Always have it**, and measure the LLM header against it.

---
## 8. Phase 4: Embeddings and indexing

### 8.1 Which embedding model (and why the default)

| Model | Dims | Max tokens | Runs via | Strength | Cost |
|---|---|---|---|---|---|
| **nomic-embed-text-v1.5** (default) | 768 (Matryoshka: 512/256 possible) | 8192 | Ollama (or ST with `trust_remote_code`) | Strong open retrieval model; long context; fast on Apple Silicon via Ollama | Needs `search_document:` / `search_query:` prefixes |
| **BAAI/bge-m3** | 1024 | 8192 | sentence-transformers | Top-tier open model, multilingual (Spanish guitar material works too) | ~570M params; slower ingest on CPU |
| **bge-small-en-v1.5** | 384 | 512 | sentence-transformers | Fast; CI model and semantic-chunking breakpoints | Lower quality; 512-token limit constrains chunk size |
| **gemini-embedding-001** (opt-in) | 768 via `output_dimensionality` | 2048 | Google API | Strong cloud baseline: "is local good enough?" | Cloud; never used for private sources |

Pick the default from your own ablation. Start with nomic because it reuses the Ollama
you already run. The interesting result to report is how close the local models get
to the cloud baseline.

**Rules that apply to every model** (each one is a common bug):
1. Use the right **query/document prefixes or instructions** for the model.
2. **L2-normalise** vectors and use cosine (`<=>`) or inner product (`<#>`) consistently.
3. When truncating Matryoshka or Gemini dimensions, **re-normalise after truncation**.
4. Store vectors and query vectors from the **same model and version**. The
   `chunk_embeddings.model` column plus the per-model index enforce this.

```python
# rag/embeddings/registry.py
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EmbedSpec:
    name: str
    dim: int
    max_tokens: int
    backend: str            # "ollama" | "st" | "gemini"
    ref: str                # backend model id
    tokenizer: str          # HF tokenizer for counting/offsets
    doc_prefix: str = ""
    query_prefix: str = ""
    cloud: bool = False


REGISTRY = {s.name: s for s in (
    EmbedSpec("nomic-embed-text-v1.5", 768, 8192, "ollama", "nomic-embed-text",
              "nomic-ai/nomic-embed-text-v1.5", "search_document: ", "search_query: "),
    EmbedSpec("bge-m3", 1024, 8192, "st", "BAAI/bge-m3", "BAAI/bge-m3"),
    EmbedSpec("bge-small-en-v1.5", 384, 512, "st", "BAAI/bge-small-en-v1.5",
              "BAAI/bge-small-en-v1.5",
              query_prefix="Represent this sentence for searching relevant passages: "),
    EmbedSpec("gemini-embedding-001", 768, 2048, "gemini", "gemini-embedding-001",
              "BAAI/bge-m3", cloud=True),   # tokenizer only approximates Gemini's for sizing
)}
```

```python
# rag/embeddings/providers.py
from __future__ import annotations

import asyncio
from functools import lru_cache

import numpy as np

from .registry import EmbedSpec


def _l2(m: np.ndarray) -> np.ndarray:
    return (m / np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-12)).astype(np.float32)


@lru_cache(maxsize=4)
def _st_model(ref: str):
    import torch
    from sentence_transformers import SentenceTransformer
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    return SentenceTransformer(ref, device=device, trust_remote_code=ref.startswith("nomic-ai/"))


class Embedder:
    """Async facade; heavy work runs in a thread so the event loop stays responsive."""

    def __init__(self, spec: EmbedSpec, allow_cloud: bool, batch: int = 32):
        if spec.cloud and not allow_cloud:
            raise PermissionError(f"{spec.name} is a cloud model; set COREGUITAR_ALLOW_CLOUD=1")
        self.spec, self.batch = spec, batch

    async def documents(self, texts: list[str]) -> np.ndarray:
        return await asyncio.to_thread(self._run, [self.spec.doc_prefix + t for t in texts], "doc")

    async def query(self, text: str) -> np.ndarray:
        return (await asyncio.to_thread(self._run, [self.spec.query_prefix + text], "query"))[0]

    def _run(self, texts: list[str], kind: str) -> np.ndarray:
        s = self.spec
        if s.backend == "st":
            return _st_model(s.ref).encode(texts, batch_size=self.batch, convert_to_numpy=True,
                                           normalize_embeddings=True, show_progress_bar=False)
        if s.backend == "ollama":
            from ...server import coach   # v1 transport: loopback-only, size-capped
            import time
            out = []
            deadline = time.monotonic() + 120
            coach.ensure_local_model(s.ref, deadline=deadline)
            for i in range(0, len(texts), self.batch):
                v = coach.request_json("/api/embed", {"model": s.ref, "input": texts[i:i + self.batch],
                                                     "truncate": True, "keep_alive": "10m"},
                                       deadline=deadline, max_bytes=coach.MAX_EMBED_RESPONSE_BYTES)
                out.extend(v["embeddings"])
            return _l2(np.asarray(out, dtype=np.float32))
        if s.backend == "gemini":
            from google import genai
            from google.genai import types
            client = genai.Client()     # reads GEMINI_API_KEY from env; never hard-code it
            task = "RETRIEVAL_DOCUMENT" if kind == "doc" else "RETRIEVAL_QUERY"
            out = []
            for i in range(0, len(texts), 64):
                r = client.models.embed_content(
                    model=s.ref, contents=texts[i:i + 64],
                    config=types.EmbedContentConfig(task_type=task, output_dimensionality=s.dim))
                out.extend(e.values for e in r.embeddings)
            return _l2(np.asarray(out, dtype=np.float32))   # re-normalise after MRL truncation
        raise ValueError(s.backend)
```

The embedding cache (`embedding_cache` keyed by `(model, sha256(prefix+text))`) works
as in v1: look up misses in one `= ANY(%s)` query, embed only those, and insert with
`ON CONFLICT DO NOTHING`. Re-ingesting after an edit costs only the changed chunks.

### 8.2 Ingest pipeline (idempotent, bulk, transactional)

**Flow per source:** hash raw bytes → unchanged? skip → load → clean → chunk with every
strategy → (contextual headers) → embed per model (cache-aware) → **one transaction**:
delete old documents for the source, insert documents and chunks, then **COPY**
embeddings → bump `index_version`.

**Why COPY:** binary `COPY` of vectors is about 10× faster than row-by-row INSERT for
bulk loads. `pgvector-python` registers the binary format.

```python
# rag/ingest.py (core)
from __future__ import annotations

import hashlib

from pgvector.psycopg import register_vector_async
from psycopg.types.json import Jsonb

from .text import clean, lexical


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def write_source(conn, src, doc, drafts_by_strategy, embeddings_by_model):
    """drafts_by_strategy: {strategy: [ChunkDraft]}; embeddings_by_model: {model: {(strategy, i): vec}}"""
    async with conn.transaction():
        await conn.execute("DELETE FROM sources WHERE id = %s", (src.id,))   # cascades
        await conn.execute(
            "INSERT INTO sources (id, kind, uri, title, license, attribution, private, sha256)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (src.id, src.kind, src.uri, src.title, src.license, src.attribution, src.private, src.sha))
        doc_id = (await (await conn.execute(
            "INSERT INTO documents (source_id, title, meta, sha256) VALUES (%s,%s,%s,%s) RETURNING id",
            (src.id, doc.title, Jsonb(doc.meta), src.sha))).fetchone())[0]

        ids: dict[tuple[str, int], int] = {}
        for strategy, drafts in drafts_by_strategy.items():
            for i, d in enumerate(drafts):
                role = d.meta.get("role")
                stored = "parent" if role == "parent" else "child" if role == "child" else strategy
                parent = ids.get((strategy, d.parent_ord)) if d.parent_ord is not None else None
                header = d.meta.get("context") or " > ".join(d.section_path)
                row = await (await conn.execute(
                    "INSERT INTO chunks (document_id, strategy, parent_id, ord, section_path, text,"
                    " context, lexical_text, token_count, meta, sha256)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (doc_id, stored, parent, i, list(d.section_path), clean(d.text), header,
                     lexical(f"{header}\n{d.text}"), d.token_count,
                     Jsonb({**doc.meta, **d.meta}), sha(d.text)))).fetchone()
                ids[(strategy, i)] = row[0]

        async with conn.cursor() as cur:
            async with cur.copy("COPY chunk_embeddings (chunk_id, model, strategy, embedding)"
                                " FROM STDIN WITH (FORMAT BINARY)") as copy:
                copy.set_types(["bigint", "text", "text", "vector"])
                for model, vecs in embeddings_by_model.items():
                    for (strategy, i), vec in vecs.items():
                        stored = "child" if strategy == "parent_child" else strategy
                        await copy.write_row((ids[(strategy, i)], model, stored, vec))
        await conn.execute(
            "INSERT INTO meta VALUES ('index_version', md5(random()::text))"
            " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
```

Call `await register_vector_async(conn)` once per pooled connection (use the pool's
`configure=` hook). Parent chunks are never embedded; skip them when building
`embeddings_by_model`.

Ingestion runs from the CLI (`coreguitar rag ingest`) or as an **arq** job when you
upload a manual in the UI:

```python
# rag/worker.py
from arq.connections import RedisSettings

from .settings import RagSettings


async def ingest_source(ctx, source_id: str) -> dict:
    return await ctx["pipeline"].ingest(source_id)       # idempotent: sha unchanged -> skip


async def startup(ctx):
    from .ingest import Pipeline
    ctx["pipeline"] = await Pipeline.create(RagSettings())


class WorkerSettings:
    functions = [ingest_source]
    on_startup = startup
    redis_settings = RedisSettings.from_dsn(RagSettings().redis_url)
    max_jobs = 1              # embedding is CPU/GPU-bound; parallel jobs just thrash
    job_timeout = 1800
    max_tries = 3
```

### 8.3 HNSW index management

```python
# rag/db.py (index management)
from psycopg import sql


async def ensure_vector_index(conn, model: str, dim: int, *, half: bool = False,
                              m: int = 16, ef_construction: int = 64) -> None:
    """Partial expression index per model. Needs autocommit (CONCURRENTLY)."""
    typ, ops = ("halfvec", "halfvec_cosine_ops") if half else ("vector", "vector_cosine_ops")
    name = f"emb_{''.join(ch if ch.isalnum() else '_' for ch in model)}_{typ}_hnsw"
    await conn.execute(sql.SQL(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON chunk_embeddings "
        "USING hnsw ((embedding::{typ}({dim})) {ops}) WITH (m = {m}, ef_construction = {efc}) "
        "WHERE model = {model}").format(
            name=sql.Identifier(name), typ=sql.SQL(typ), dim=sql.Literal(dim),
            ops=sql.SQL(ops), m=sql.Literal(m), efc=sql.Literal(ef_construction),
            model=sql.Literal(model)))
```

**HNSW parameters:**

| Parameter | Effect | Start | Sweep in benchmark |
|---|---|---|---|
| `m` | Graph degree; higher means better recall, more memory, slower build | 16 | 8, 16, 32 |
| `ef_construction` | Build-time candidate list; higher means a better graph and slower build | 64 | 64, 128, 256 |
| `hnsw.ef_search` (query) | Query-time candidate list; must be ≥ k, and the main knob for recall vs latency | 80 | 20, 40, 80, 160, 320 |
| `hnsw.iterative_scan` | pgvector 0.8: keeps scanning when filters remove results | `relaxed_order` | off vs relaxed vs strict |

Use `ANALYZE chunk_embeddings` after bulk loads. Check the plan with `EXPLAIN (ANALYZE,
BUFFERS)` that the query hits `Index Scan using emb_..._hnsw`. That screenshot goes in
the README.

---

## 9. Phase 5: Retrieval

### 9.1 Hybrid retrieval in one SQL statement

**Why one statement:** one round-trip; Postgres runs the dense, lexical and tag CTEs
and fuses them with RRF where the data lives, so only the final top-k rows cross the
network. Every ranker is visible and tunable in SQL you wrote, which is exactly what
interviewers probe.

**Details that matter:**
- The dense CTE orders by **raw distance in an inner query with `LIMIT`**. That is the
  shape the planner can serve from HNSW. `row_number()` is applied *outside*. It also
  re-sorts correctly when `iterative_scan = relaxed_order` returns slightly out-of-order
  rows.
- `set_config(..., true)` scopes `ef_search` and `iterative_scan` to the transaction,
  using bound parameters (a plain `SET` cannot take bind parameters).
- The lexical query uses an **OR** tsquery built from sanitised tokens. The default
  `websearch_to_tsquery` ANDs every word, which kills recall for natural questions
  ("how do I stop my notes landing late"). Tokens are restricted to `[a-z0-9]`, so user
  input can never produce tsquery syntax errors or injection.
- `ts_rank_cd(..., 32)` normalises the rank to the range 0–1 (`rank/(rank+1)`). It only
  affects the lexical ordering; RRF uses ranks, not scores.
- The tag ranker orders chunks by the **priority position** of their finding type in
  the take.
- **Ablations** turn a ranker off by setting its `LIMIT` to 0. It is the same SQL
  statement, so measurements are comparable.
- The dimension is injected with `sql.Literal` from the registry (a type modifier
  cannot be a bind parameter). Everything user-controlled is a bind parameter.

```python
# rag/retrieval/hybrid_sql.py
from __future__ import annotations

import re
from dataclasses import dataclass

from psycopg import sql
from psycopg.types.json import Jsonb

from ..text import lexical

HYBRID = """
WITH dense AS (
  SELECT chunk_id, row_number() OVER (ORDER BY dist) AS r, dist
  FROM (
    SELECT e.chunk_id, e.embedding::vector({dim}) <=> %(q)s::vector({dim}) AS dist
    FROM chunk_embeddings e
    JOIN chunks c ON c.id = e.chunk_id
    WHERE e.model = %(model)s AND e.strategy = ANY(%(strategies)s) AND c.meta @> %(filter)s
    ORDER BY dist
    LIMIT %(k_dense)s
  ) d
),
lexical AS (
  SELECT id AS chunk_id, row_number() OVER (ORDER BY rank DESC, id) AS r
  FROM (
    SELECT c.id, ts_rank_cd(c.tsv, q, 32) AS rank
    FROM chunks c, to_tsquery('english', %(tsq)s) q
    WHERE %(tsq)s <> '' AND c.tsv @@ q
      AND c.strategy = ANY(%(strategies)s) AND c.meta @> %(filter)s
    ORDER BY rank DESC
    LIMIT %(k_lex)s
  ) l
),
tags AS (
  SELECT id AS chunk_id, row_number() OVER (ORDER BY prio, id) AS r
  FROM (
    SELECT c.id, min(array_position(%(types)s::text[], t)) AS prio
    FROM chunks c, jsonb_array_elements_text(c.meta -> 'finding_types') t
    WHERE cardinality(%(types)s::text[]) > 0 AND c.meta -> 'finding_types' ?| %(types)s::text[]
      AND t = ANY(%(types)s::text[]) AND c.strategy = ANY(%(strategies)s)
    GROUP BY c.id
    ORDER BY prio, c.id
    LIMIT %(k_tags)s
  ) t
),
fused AS (
  SELECT chunk_id, sum(1.0 / (%(rrf_k)s + r)) AS score, jsonb_object_agg(src, r) AS ranks
  FROM (
    SELECT chunk_id, r, 'dense' AS src FROM dense
    UNION ALL SELECT chunk_id, r, 'lexical' FROM lexical
    UNION ALL SELECT chunk_id, r, 'tags' FROM tags
  ) u
  GROUP BY chunk_id
  ORDER BY score DESC
  LIMIT %(k_out)s
)
SELECT f.chunk_id, f.score, f.ranks, 1 - d.dist AS cosine,
       c.text, c.context, c.parent_id, c.section_path, c.meta,
       doc.title, s.id AS source_id, s.license, s.attribution, s.private,
       e.embedding::vector({dim}) AS embedding
FROM fused f
JOIN chunks c ON c.id = f.chunk_id
JOIN documents doc ON doc.id = c.document_id
JOIN sources s ON s.id = doc.source_id
LEFT JOIN dense d ON d.chunk_id = f.chunk_id
LEFT JOIN chunk_embeddings e ON e.chunk_id = f.chunk_id AND e.model = %(model)s
ORDER BY f.score DESC
"""

_TOKEN = re.compile(r"[a-z0-9]{2,}")


def or_tsquery(text: str, max_terms: int = 16) -> str:
    terms = list(dict.fromkeys(_TOKEN.findall(lexical(text))))[:max_terms]
    return " | ".join(terms)          # only [a-z0-9] tokens -> always valid tsquery


@dataclass(frozen=True)
class Hit:
    chunk_id: int
    score: float
    ranks: dict
    cosine: float | None
    text: str
    context: str | None
    parent_id: int | None
    section_path: list[str]
    meta: dict
    title: str
    source_id: str
    license: str
    attribution: str
    private: bool
    embedding: object | None


async def hybrid(conn, *, spec, qvec, query: str, strategies: list[str], finding_types: list[str],
                 filters: dict, s, use_dense=True, use_lexical=True, use_tags=True) -> list[Hit]:
    stmt = sql.SQL(HYBRID).format(dim=sql.Literal(spec.dim))
    async with conn.transaction():
        await conn.execute("SELECT set_config('hnsw.ef_search', %s, true),"
                           " set_config('hnsw.iterative_scan', 'relaxed_order', true)",
                           (str(s.ef_search),))
        cur = await conn.execute(stmt, {
            "q": qvec, "model": spec.name, "strategies": strategies, "filter": Jsonb(filters),
            "tsq": or_tsquery(query), "types": finding_types,
            "k_dense": s.k_dense if use_dense else 0,
            "k_lex": s.k_lexical if use_lexical else 0,
            "k_tags": s.k_tags if use_tags and finding_types else 0,
            "rrf_k": s.rrf_k, "k_out": s.k_rerank_in})
        return [Hit(*row) for row in await cur.fetchall()]
```

> **Retrieval strategies.** Pass `strategies=["child"]` for parent-child, or
> `["semantic"]`, `["sliding"]`, `["recursive"]` for the others. Never mix strategies
> in one query outside of experiments: overlapping chunks from different strategies
> would duplicate content in the prompt.

### 9.2 Reranking (cross-encoder)

**Why:** the bi-encoder (embedding) compares a query vector with a chunk vector that was
computed independently. A cross-encoder reads the query and the chunk **together**, so
it is far more precise but O(k) model calls. Use it only on the fused top 24 (the
"retrieve wide, rerank narrow" pattern). Its scores also serve as the **grading
signal** for the corrective loop (§10).

```python
# rag/retrieval/rerank.py
from __future__ import annotations

import asyncio
from dataclasses import replace
from functools import lru_cache

import numpy as np

_gate = asyncio.Semaphore(1)       # threads can't be cancelled; never queue more than one


@lru_cache(maxsize=2)
def _model(name: str):
    from sentence_transformers import CrossEncoder
    return CrossEncoder(name, max_length=512)


def _prob(x: np.ndarray) -> np.ndarray:
    # Some sentence-transformers versions return logits for 1-label models; normalise to [0, 1]
    return x if (x.min() >= 0 and x.max() <= 1) else 1 / (1 + np.exp(-x))


async def rerank(name: str, query: str, hits: list, k: int, timeout_s: float) -> tuple[list, bool]:
    if not hits:
        return hits, False
    pairs = [(query, (h.context + "\n" if h.context else "") + h.text) for h in hits]
    try:
        async with _gate:
            raw = await asyncio.wait_for(
                asyncio.to_thread(lambda: _model(name).predict(pairs, batch_size=16,
                                                              convert_to_numpy=True)),
                timeout=timeout_s)
    except (asyncio.TimeoutError, RuntimeError, OSError):
        return hits[:k], False                    # degrade to fused order, never fail the request
    scores = _prob(np.asarray(raw, dtype=np.float32))
    order = np.argsort(-scores)[:k]
    return [replace(hits[i], score=float(scores[i])) for i in order], True
```

Warm it at startup (one dummy `predict`) from the FastAPI lifespan. Compare
`bge-reranker-v2-m3` (more accurate, ~570M params) with `bge-reranker-base` (about 3×
faster) in the ablation and report the latency cost of each point of precision.

### 9.3 MMR (diversity)

**Why:** the top 6 can be six near-identical chunks (overlapping windows, or the same
drill restated on two pages). Maximal Marginal Relevance trades a little relevance for
coverage: `λ·rel(d) − (1−λ)·max_sim(d, selected)`. It reuses the embeddings already
returned by the SQL, so it costs no extra queries.

```python
# rag/retrieval/mmr.py
import numpy as np


def mmr(hits: list, k: int, lam: float = 0.7) -> list:
    if len(hits) <= k or hits[0].embedding is None:
        return hits[:k]
    E = np.vstack([np.asarray(h.embedding, dtype=np.float32) for h in hits])
    rel = np.array([h.score for h in hits], dtype=np.float32)
    rel = (rel - rel.min()) / (np.ptp(rel) or 1.0)
    sim = E @ E.T
    chosen = [int(np.argmax(rel))]
    while len(chosen) < k:
        rest = [i for i in range(len(hits)) if i not in chosen]
        penalty = sim[np.ix_(rest, chosen)].max(axis=1)
        chosen.append(rest[int(np.argmax(lam * rel[rest] - (1 - lam) * penalty))])
    return [hits[i] for i in chosen]
```

### 9.4 Parent expansion (small-to-big)

After reranking the **children**, replace each one with its parent, keep the best child
score per parent, deduplicate, and stop at the token budget. That is one
`SELECT ... WHERE id = ANY(%s)` query. Cite the **parent** chunk ID, so the citation
points to the text the LLM actually read.

### 9.5 Query transforms and self-query (optional, ablated)

| Transform | How | When it helps | Cost |
|---|---|---|---|
| **Multi-query** | LLM writes 3 paraphrases; retrieve each; RRF across lists | Vague or short questions ("tone?") | 1 LLM call + 3 retrievals (run with `asyncio.gather`) |
| **HyDE** | LLM writes a hypothetical answer passage; embed *that* for the dense ranker only | Questions phrased very differently from the corpus | 1 LLM call; hallucinated content only affects retrieval, never the answer |
| **Step-back** | LLM generalises ("why does my G chord buzz" → "causes of fret buzz") | Specific symptoms with general fixes in the corpus | 1 LLM call |
| **Self-query** | Parse filters: tuning, BPM range, key, technique, topic | Riff library and tone manuals | Rules first (free); LLM extraction only if rules find nothing |

```python
# rag/retrieval/transforms.py (self-query: rules first, deterministic and free)
import re

TUNINGS = {"drop d": "D A D G B E", "standard": "E A D G B E", "dadgad": "D A D G A D",
           "half step down": "Eb Ab Db Gb Bb Eb", "eb standard": "Eb Ab Db Gb Bb Eb"}
TECH = {"palm mute": "palm_mute", "bend": "bend", "slide": "slide", "legato": "hammer_pull"}


def self_query(q: str) -> tuple[dict, dict]:
    """Returns (jsonb containment filter, range constraints applied in Python)."""
    ql, filt, ranges = q.lower(), {}, {}
    for name, value in TUNINGS.items():
        if name in ql:
            filt["tuning"] = value
    techs = [v for k, v in TECH.items() if k in ql]
    if techs:
        filt["techniques"] = techs                    # jsonb @> matches arrays as subsets
    if m := re.search(r"(\d{2,3})\s*bpm", ql):
        bpm = int(m.group(1))
        ranges["bpm"] = (bpm - 10, bpm + 10)
    if m := re.search(r"\b(?:in\s+)?([a-g](?:#|b)?)\s*(major|minor|m)\b", ql):
        filt["key"] = f"{m.group(1).upper()} {'minor' if m.group(2) in ('minor', 'm') else 'major'}"
    if any(w in ql for w in ("riff", "tab", "song", "lick")):
        filt["kind"] = "riff"
    return filt, ranges
```

Apply BPM ranges as an extra `WHERE (c.meta->>'bpm')::int BETWEEN …` clause on the
riff route, or filter in Python on the top 50 (simpler; fine at riff-library scale).

---
## 10. Phase 6: Orchestration with LangGraph (bounded, corrective RAG)

### 10.1 Why LangGraph (and why bounded)

A plain chain (retrieve → generate) cannot express "if retrieval is weak, rewrite once
and retry, otherwise refuse". LangGraph makes that control flow an **explicit state
machine** you can draw, test node by node, trace in Phoenix, and bound. It is
*not* an open-ended agent: every edge is deterministic except the router, and the loop
runs **at most one rewrite**. That is the main safeguard against latency blow-ups.

```
          ┌─────────┐
 query ──▶│  route  │──(take / riff / tone / theory / chit-chat)
          └────┬────┘
               ▼
        ┌────────────┐     ┌──────────┐     ┌─────────┐
        │ transform  │────▶│ retrieve │────▶│  grade  │
        └────────────┘     └──────────┘     └────┬────┘
               ▲                 good ───────────┤──── weak & rewrites==0
               │                                 ▼                │
               │                          ┌───────────┐           │
               │                          │ generate  │           │
               │                          └─────┬─────┘           │
               └──── rewrite ◀──────────────────┼─────────────────┘
                                                ▼
                                          ┌──────────┐  fail  ┌──────────┐
                                          │  verify  │───────▶│ fallback │
                                          └────┬─────┘        └──────────┘
                                               ▼ pass
                                              END
                         weak & rewrites==1 ──▶ refuse ──▶ END
```

### 10.2 State and structured output

```python
# rag/graph/state.py
from __future__ import annotations

import operator
from typing import Annotated, Literal, TypedDict

from pydantic import BaseModel, Field

Route = Literal["take", "riff", "tone", "theory", "smalltalk"]


class Cite(BaseModel):
    chunk_id: int
    quote: str = Field(max_length=300, description="Exact span copied from the chunk")


class Answer(BaseModel):
    summary: str = Field(max_length=600)
    points: list[str] = Field(max_length=6)
    citations: list[Cite] = Field(max_length=8)
    finding_refs: list[str] = Field(default_factory=list, description="Finding ids, e.g. F3")
    insufficient_context: bool = False


class RagState(TypedDict, total=False):
    query: str
    take_id: str | None
    route: Route
    filters: dict
    finding_types: list[str]
    findings_block: str            # v1 Phase 6 output
    queries: list[str]             # after transform
    hits: list                     # Hit objects after rerank+MMR+parent expansion
    top_score: float
    reranked: bool
    rewrites: int
    answer: Answer | None
    verdict: dict | None           # v1 verify.py output
    events: Annotated[list[dict], operator.add]   # every node appends; streamed over SSE
```

`Answer` is the contract for `with_structured_output(method="json_schema")`: Ollama
constrains decoding to the schema, so a 3B model cannot return malformed JSON. A
parse failure is still possible on truncation; treat it as a verify failure, not a crash.

### 10.3 LLM factory (local by default, privacy-aware)

```python
# rag/llm.py
from __future__ import annotations

from functools import lru_cache

from .settings import RagSettings


class CloudBlocked(PermissionError):
    pass


@lru_cache(maxsize=8)
def chat_model(provider: str, model: str, temperature: float = 0.1):
    if provider == "ollama":
        from langchain_ollama import ChatOllama
        return ChatOllama(model=model, temperature=temperature, num_ctx=8192,
                          base_url="http://127.0.0.1:11434", keep_alive="10m")
    if provider == "groq":
        from langchain_groq import ChatGroq
        return ChatGroq(model=model, temperature=temperature, max_retries=1, timeout=20)
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_retries=1)
    raise ValueError(provider)


def llm_for(s: RagSettings, *, contains_private: bool, structured=None):
    provider = s.llm_provider
    if provider != "ollama":
        if not s.allow_cloud:
            raise CloudBlocked("cloud LLM disabled (COREGUITAR_ALLOW_CLOUD=0)")
        if contains_private:
            provider = "ollama"                       # privacy wins over quality, silently logged
    m = chat_model(provider, s.llm_model if provider != "ollama" else s.local_llm_model)
    return m.with_structured_output(structured, method="json_schema") if structured else m
```

**Rule:** the decision is made *after* retrieval, because only then do you know whether
any hit has `private = true` (your manuals, your GP files, your takes). The take's
findings block always counts as private.

### 10.4 Nodes

```python
# rag/graph/nodes.py
from __future__ import annotations

import asyncio
import re

from ..findings_ctx import findings_block, finding_types_for     # v1 Phase 6
from ..llm import llm_for
from ..retrieval.hybrid_sql import hybrid
from ..retrieval.mmr import mmr
from ..retrieval.parents import expand_parents
from ..retrieval.rerank import rerank
from ..retrieval.transforms import multi_query, hyde, self_query
from ..verify import verify_answer                                # v1 Phase 8
from .prompts import ANSWER_PROMPT, REWRITE_PROMPT, REFUSAL
from .state import Answer, RagState

_RIFF = re.compile(r"\b(riff|tab|lick|song|tuning|bpm)\b", re.I)
_TONE = re.compile(r"\b(tone|amp|gain|eq|pedal|overdrive|distortion|reverb|delay|pickup)\b", re.I)
_THEORY = re.compile(r"\b(scale|mode|chord|interval|key|arpeggio|triad|cadence)\b", re.I)


def make_nodes(deps):
    """deps: pool, settings, spec, embedder, analysis loader. Closures keep nodes pure-ish."""
    s = deps.settings

    async def route(st: RagState) -> RagState:
        q = st["query"]
        r = ("take" if st.get("take_id") else "riff" if _RIFF.search(q)
             else "tone" if _TONE.search(q) else "theory" if _THEORY.search(q) else "theory")
        filt, _ = self_query(q) if r in ("riff", "tone") else ({}, {})
        if r == "tone":
            filt.setdefault("topic", "tone")
        out: RagState = {"route": r, "filters": filt, "rewrites": st.get("rewrites", 0),
                         "events": [{"stage": "route", "route": r, "filters": filt}]}
        if r == "take":
            analysis = await deps.load_analysis(st["take_id"])
            out["findings_block"] = findings_block(analysis)
            out["finding_types"] = finding_types_for(analysis)
        return out

    async def transform(st: RagState) -> RagState:
        q = st["query"]
        mode = s.query_transform
        if mode == "multi":
            qs = [q, *await multi_query(deps.local_llm, q, n=3)]
        elif mode == "hyde":
            qs = [q, await hyde(deps.local_llm, q)]        # hyde text only feeds the dense ranker
        else:
            qs = [q]
        return {"queries": qs, "events": [{"stage": "transform", "n": len(qs)}]}

    async def retrieve(st: RagState) -> RagState:
        strategies = ["child"] if s.chunk_strategy == "parent_child" else [s.chunk_strategy]
        vecs = await asyncio.gather(*(deps.embedder.query(q) for q in st["queries"]))

        async def one(q, v):
            async with deps.pool.connection() as conn:
                return await hybrid(conn, spec=deps.spec, qvec=v, query=q, strategies=strategies,
                                    finding_types=st.get("finding_types", []),
                                    filters=st.get("filters", {}), s=s)

        lists = await asyncio.gather(*(one(q, v) for q, v in zip(st["queries"], vecs)))
        fused = _rrf_lists(lists, k=s.rrf_k)[: s.k_rerank_in] if len(lists) > 1 else lists[0]
        hits, reranked = await rerank(s.reranker, st["query"], fused, s.k_rerank_in,
                                      s.rerank_timeout_s)
        hits = mmr(hits, s.k_final, s.mmr_lambda)
        if s.chunk_strategy == "parent_child":
            async with deps.pool.connection() as conn:
                hits = await expand_parents(conn, hits, s.max_evidence_tokens)
        top = max((h.score for h in hits), default=0.0) if reranked else None
        return {"hits": hits, "reranked": reranked,
                "top_score": top if top is not None else 1.0,   # no reranker -> can't grade
                "events": [{"stage": "retrieve", "n": len(hits), "reranked": reranked,
                            "top": top}]}

    async def rewrite(st: RagState) -> RagState:
        q = (await deps.local_llm.ainvoke(REWRITE_PROMPT.format(query=st["query"]))).content
        return {"queries": [q.strip()[:300]], "rewrites": st["rewrites"] + 1,
                "events": [{"stage": "rewrite", "query": q.strip()[:300]}]}

    async def generate(st: RagState) -> RagState:
        private = any(h.private for h in st["hits"]) or st["route"] == "take"
        llm = llm_for(s, contains_private=private, structured=Answer)
        prompt = ANSWER_PROMPT.format(findings=st.get("findings_block", "(no take)"),
                                      evidence=_evidence(st["hits"]), query=st["query"])
        try:
            ans = await asyncio.wait_for(llm.ainvoke(prompt), timeout=s.generate_timeout_s)
        except (asyncio.TimeoutError, ValueError):
            ans = None
        return {"answer": ans, "events": [{"stage": "generate", "ok": ans is not None}]}

    async def verify(st: RagState) -> RagState:
        v = verify_answer(st["answer"], st["hits"], st.get("findings_block", "")) \
            if st.get("answer") else {"ok": False, "reason": "no_answer"}
        return {"verdict": v, "events": [{"stage": "verify", **{k: v[k] for k in ("ok", "reason")
                                                             if k in v}}]}

    async def fallback(st: RagState) -> RagState:
        # v1 behaviour: deterministic findings-only advice from knowledge.py; never a raw LLM answer
        return {"answer": deps.deterministic_answer(st), "events": [{"stage": "fallback"}]}

    async def refuse(st: RagState) -> RagState:
        return {"answer": Answer(summary=REFUSAL, points=[], citations=[],
                                 insufficient_context=True),
                "events": [{"stage": "refuse", "top": st.get("top_score")}]}

    return dict(route=route, transform=transform, retrieve=retrieve, rewrite=rewrite,
                generate=generate, verify=verify, fallback=fallback, refuse=refuse)


def _rrf_lists(lists, k: int):
    score, best = {}, {}
    for hits in lists:
        for r, h in enumerate(hits, 1):
            score[h.chunk_id] = score.get(h.chunk_id, 0.0) + 1.0 / (k + r)
            best.setdefault(h.chunk_id, h)
    return [best[c] for c in sorted(score, key=score.get, reverse=True)]


def _evidence(hits) -> str:
    return "\n\n".join(f"[C{h.chunk_id}] ({h.title} — {h.license})\n"
                       f"{(h.context + chr(10)) if h.context else ''}{h.text}" for h in hits)
```

### 10.5 Graph wiring

```python
# rag/graph/build.py
from langgraph.graph import END, START, StateGraph

from .nodes import make_nodes
from .state import RagState


def build_graph(deps):
    n, s = make_nodes(deps), deps.settings
    g = StateGraph(RagState)
    for name, fn in n.items():
        g.add_node(name, fn)

    g.add_edge(START, "route")
    g.add_conditional_edges("route", lambda st: "refuse" if st["route"] == "smalltalk"
                            else "transform", {"refuse": "refuse", "transform": "transform"})
    g.add_edge("transform", "retrieve")

    def grade(st):
        if st.get("route") == "take" and st.get("findings_block"):
            return "generate"            # findings alone are valid evidence
        if st["top_score"] >= s.grade_threshold:
            return "generate"
        return "rewrite" if st["rewrites"] == 0 else "refuse"

    g.add_conditional_edges("retrieve", grade,
                            {"generate": "generate", "rewrite": "rewrite", "refuse": "refuse"})
    g.add_edge("rewrite", "retrieve")
    g.add_edge("generate", "verify")
    g.add_conditional_edges("verify", lambda st: END if st["verdict"]["ok"] else "fallback",
                            {END: END, "fallback": "fallback"})
    g.add_edge("fallback", END)
    g.add_edge("refuse", END)
    return g.compile()
```

`events` uses an `operator.add` reducer (see `RagState`), so each node appends to the
list instead of overwriting it. Without it, the trace only shows the last stage.

**Calibrating `grade_threshold`:** do not guess 0.15. Run the labelled retrieval set,
plot the top-1 rerank score for answerable vs unanswerable queries, and pick the
threshold that maximises refusal accuracy (§13). Put the plot in the README.

---

## 11. Phase 7: Serving (FastAPI SSE, caches, worker)

### 11.1 Endpoint flow

```
POST /api/rag/ask {query, take_id?}
  → validate (store.valid_id, len ≤ 500)
  → exact cache (Redis, key = sha(index_version|model|strategy|take_id|normalised query))
  → semantic cache (pgvector, cosine ≥ 0.95, same scope + index_version + same entities)
  → graph.astream(stream_mode="updates")  → SSE "progress" events
  → final verified Answer → SSE "answer" event → write both caches
```

**Why stream progress events instead of tokens:** the verifier can delete unsupported
sentences *after* generation. If raw tokens were streamed, the user would already have
read text that is then retracted. Progress events ("searching… reranking 24 → 6…
checking citations…") give the same feeling of responsiveness, and the final answer is
always the verified one.

```python
# server/rag_api.py
from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..rag.text import lexical
from .. import store

router = APIRouter(prefix="/api/rag")


class AskIn(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    take_id: str | None = None


def cache_key(index_version: str, s, body: AskIn) -> str:
    raw = "|".join([index_version, s.embed_model, s.chunk_strategy, s.llm_model,
                    body.take_id or "-", lexical(body.query)])
    return "rag:ask:" + hashlib.sha256(raw.encode()).hexdigest()


@router.post("/ask")
async def ask(body: AskIn, request: Request):
    if body.take_id and not store.valid_id(body.take_id):
        raise HTTPException(400, "invalid take id")
    rt = request.app.state.rag                 # created in lifespan; None if [rag] not installed
    if rt is None:
        raise HTTPException(503, "RAG not enabled: pip install 'coreguitar[rag]' + docker compose up")

    async def stream():
        version = await rt.index_version()
        key = cache_key(version, rt.settings, body)
        if hit := await rt.redis.get(key):
            yield {"event": "answer", "data": hit.decode()}
            return
        qvec = await rt.embedder.query(body.query)
        if hit := await rt.semantic_cache.get(qvec, body, version):
            yield {"event": "answer", "data": hit}
            return
        final = {}
        async for update in rt.graph.astream({"query": body.query, "take_id": body.take_id,
                                              "rewrites": 0, "events": []},
                                             stream_mode="updates"):
            for node, delta in update.items():
                final.update(delta)
                for ev in delta.get("events", []):
                    yield {"event": "progress", "data": json.dumps(ev)}
            if await request.is_disconnected():
                return                             # stop work when the client leaves
        payload = rt.render(final)                 # Answer + citations + sources + verdict
        data = json.dumps(payload)
        if payload["cacheable"]:                   # never cache fallbacks/refusals
            await rt.redis.set(key, data, ex=86_400)
            await rt.semantic_cache.put(qvec, body, version, data)
        yield {"event": "answer", "data": data}

    return EventSourceResponse(stream(), ping=15)
```

**Lifespan:** create the psycopg `AsyncConnectionPool(min_size=1, max_size=8,
configure=register_vector_async)`, the Redis client, the embedder, warm the reranker and
the embedding model with one dummy call, compile the graph once, and store it all on
`app.state.rag`. Wrap it in `try/except ImportError` so the core app keeps working
without the `[rag]` extra.

### 11.2 Semantic cache (and why it is dangerous)

A semantic cache returns a stored answer for a *similar* question. That is a big latency
win (~5 ms vs ~3 s), and also the easiest way to return a **wrong** answer:
"why is bar 5 rushed?" and "why is bar 6 rushed?" have cosine ≈ 0.98.

Guards, all required:
1. **Same scope:** same `take_id` (or both none), same model, strategy and `index_version`.
2. **Entity match:** extract numbers, note names, tunings and finding IDs with regex; the
   sets must be **equal**.
3. **High threshold:** ≥ 0.95, tuned on a paraphrase/non-paraphrase set (§13).
4. **TTL**, and only cache verified, non-fallback answers.

```python
# rag/cache/semantic.py
import re

# Case-sensitive on purpose: note names are capitalised, so the article "a" never matches.
# Lookarounds instead of \b, because \b fails after "#" ("C#").
ENT = re.compile(r"(?<![\w#])(?:\d+|[A-G][#b]?\d?|[Ff]\d+|[Dd]rop ?[A-G]|DADGAD)(?![\w#])")


def entities(q: str) -> list[str]:
    return sorted({e.replace(" ", "") for e in ENT.findall(q)})


GET = """
SELECT answer FROM semantic_cache
WHERE model = %(model)s AND scope = %(scope)s AND index_version = %(v)s
  AND entities = %(ents)s AND created_at > now() - interval '7 days'
  AND 1 - (embedding::vector({dim}) <=> %(q)s::vector({dim})) >= %(thr)s
ORDER BY embedding::vector({dim}) <=> %(q)s::vector({dim})
LIMIT 1
"""
```

The cache table is small, so an exact scan is fine. Do not add an HNSW index until it
exceeds ~50k rows.

### 11.3 What runs where

| Process | Command | Why separate |
|---|---|---|
| API | `coreguitar serve` (existing) | Request path stays light |
| Worker | `arq coreguitar.rag.worker.WorkerSettings` | Ingest is minutes of CPU/GPU; must not block requests |
| Postgres, Redis, Phoenix | `docker compose -f docker-compose.rag.yml up -d` | Optional infrastructure behind the extra |
| MCP server | `coreguitar rag mcp` (stdio) | Separate client surface (§14) |

---
## 12. Phase 8: Observability (OpenTelemetry + Arize Phoenix)

**Why:** "the answer was bad" is not debuggable on its own. You need to see, per request:
which route, which query variants, what each ranker returned, the rerank scores, the
prompt, the tokens, which sentences the verifier dropped, and where the time went.
Phoenix is open source, runs locally in the compose file, and understands LangChain and
LangGraph spans through OpenInference.

```python
# rag/tracing.py
from __future__ import annotations

from contextlib import contextmanager

_tracer = None


def init_tracing(endpoint: str = "http://127.0.0.1:6006/v1/traces") -> None:
    global _tracer
    from openinference.instrumentation.langchain import LangChainInstrumentor
    from opentelemetry import trace
    from phoenix.otel import register

    provider = register(project_name="coreguitar-rag", endpoint=endpoint, batch=True)
    LangChainInstrumentor().instrument(tracer_provider=provider)    # LangGraph nodes + LLM calls
    _tracer = trace.get_tracer("coreguitar.rag")


@contextmanager
def span(name: str, **attrs):
    if _tracer is None:                    # tracing off -> zero overhead
        yield None
        return
    with _tracer.start_as_current_span(name) as sp:
        for k, v in attrs.items():
            sp.set_attribute(f"rag.{k}", v if isinstance(v, (str, int, float, bool)) else str(v))
        yield sp
```

Wrap the hybrid SQL call (`span("retrieve.sql", k_dense=…, ef_search=…)`), rerank and
verify. Record **counts, IDs, scores and timings**, never chunk text from private
sources: traces are stored data too. Add a `COREGUITAR_TRACE_CONTENT=0` default that
strips prompt and completion bodies from the LangChain spans for private routes.

**Metrics worth dashboarding:** p50/p95 latency per stage, rerank fallback rate, refusal
rate, verifier strip rate, cache hit rate (exact vs semantic), and cloud vs local call
share.

---

## 13. Phase 9: Evaluation (the part that gets you hired)

Nobody believes "I built RAG". People believe "**hybrid + rerank lifted Recall@6 from
0.58 to 0.83, semantic chunking beat sliding window by 6 points nDCG, and here is the
table**". Every tool in §1 must earn its place in this section.

### 13.1 Datasets

| Set | Size | How built | Measures |
|---|---|---|---|
| **Retrieval gold** | 120–200 queries | Hand-written: question → relevant chunk *spans* (store `source_id` + char offsets, not chunk IDs, so labels survive re-chunking) | Recall@k, MRR, nDCG |
| **Synthetic takes** | 40–60 | Render GP/MIDI with injected errors (late notes, wrong pitches, muted bends); ground truth = injected findings | End-to-end coaching quality |
| **Generated QA** | 150 | LLM proposes Q/A per chunk; **you review and delete bad ones** (record the reject rate) | RAGAS answer metrics |
| **Unanswerable** | 40 | Questions the corpus can't answer ("best strings for a 7-string baritone?") | Refusal accuracy |
| **Cache pairs** | 100 | Paraphrase vs near-miss pairs ("bar 5" vs "bar 6") | Semantic-cache precision |

**Span-based labels:** a chunk counts as relevant if it overlaps ≥ 50% of a gold span.
That is what lets you compare chunkers fairly: different strategies produce different
chunk IDs, but the same spans.

### 13.2 Retrieval metrics

```python
# rag/eval/metrics.py
from __future__ import annotations

import math


def recall_at_k(ranked: list[bool], n_relevant: int, k: int) -> float:
    return sum(ranked[:k]) / n_relevant if n_relevant else 0.0


def mrr(ranked: list[bool]) -> float:
    return next((1 / (i + 1) for i, r in enumerate(ranked) if r), 0.0)


def ndcg_at_k(gains: list[float], k: int) -> float:
    dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains[:k]))
    ideal = sum(g / math.log2(i + 2) for i, g in enumerate(sorted(gains, reverse=True)[:k]))
    return dcg / ideal if ideal else 0.0


def overlaps(chunk_span: tuple[str, int, int], gold: tuple[str, int, int], min_frac=0.5) -> bool:
    (s1, a1, b1), (s2, a2, b2) = chunk_span, gold
    if s1 != s2:
        return False
    inter = max(0, min(b1, b2) - max(a1, a2))
    return inter >= min_frac * (b2 - a2)


def bootstrap_ci(xs: list[float], n: int = 2000, seed: int = 7) -> tuple[float, float]:
    import random
    rnd, m = random.Random(seed), len(xs)
    means = sorted(sum(rnd.choice(xs) for _ in range(m)) / m for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]
```

**Report confidence intervals.** With 150 queries, a 2-point difference is often noise.
Paired bootstrap (same queries, configs A vs B) is the honest comparison, and saying
that in an interview signals seniority.

### 13.3 Generation metrics (RAGAS + custom)

| Metric | Tool | What it catches |
|---|---|---|
| Faithfulness | RAGAS | Claims not supported by context |
| Answer relevancy | RAGAS | On-topic but evasive answers |
| Context precision / recall | RAGAS | Noisy or missing evidence |
| **Citation precision** | custom (v1 Phase 10) | Cited chunk doesn't contain the quote |
| **Finding grounding** | custom | Advice for a finding that is not in the take |
| **Refusal accuracy** | custom | Answers when it should refuse, and the reverse |
| Latency p50/p95, cost | custom | Regressions |

```python
# rag/eval/ragas_run.py: pin ragas (e.g. ragas==0.2.*); the API changes between minors
from ragas import EvaluationDataset, evaluate
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.metrics import Faithfulness, ResponseRelevancy, LLMContextPrecisionWithReference, LLMContextRecall


def run_ragas(rows: list[dict], judge_llm, judge_emb):
    """rows: {user_input, retrieved_contexts, response, reference}"""
    ds = EvaluationDataset.from_list(rows)
    return evaluate(ds, metrics=[Faithfulness(), ResponseRelevancy(),
                                 LLMContextPrecisionWithReference(), LLMContextRecall()],
                    llm=LangchainLLMWrapper(judge_llm),
                    embeddings=LangchainEmbeddingsWrapper(judge_emb)).to_pandas()
```

**Judge rules:**
- The judge must be **stronger than the generator**: `qwen2.5:14b` locally, or an opt-in
  cloud model on public-corpus questions only.
- **Calibrate:** label ~30 answers yourself, then report judge–human agreement (Cohen's
  κ). If κ < 0.6, don't trust that metric. Say so in the README.
- Use a fixed seed and temperature 0, and cache judge calls by hash so reruns are cheap.

### 13.4 Ablation matrix

Run every configuration over the same datasets; one CSV row per config.

| Axis | Values |
|---|---|
| Chunker | sliding 256/64, recursive 320, semantic p90, parent-child 1024→128 |
| Contextual header | none, breadcrumb, LLM |
| Embedding model | bge-small, nomic-v1.5, bge-m3, (gemini opt-in) |
| Retrieval | dense, BM25, dense+BM25, +tags |
| Rerank | none, bge-reranker-base, bge-reranker-v2-m3 |
| Transform | none, multi-query, HyDE |
| MMR | off, λ=0.7 |

That is a big grid. Do **one-factor-at-a-time** from a baseline, then a small full grid
over the 2–3 axes that mattered. Cache embeddings per (model, strategy) so each grid
point is just retrieval.

```python
# rag/eval/ablate.py (shape)
import time

import pandas as pd

from .metrics import bootstrap_ci, mrr, overlaps, recall_at_k


async def ablate(configs: list[dict], queries, gold, runner) -> pd.DataFrame:
    rows = []
    for cfg in configs:
        lat, recs, mrrs = [], [], []
        for q in queries:
            t = time.perf_counter()
            hits = await runner.retrieve(q.text, **cfg)
            lat.append((time.perf_counter() - t) * 1000)
            rel = [any(overlaps(h.span, g) for g in gold[q.id]) for h in hits]
            recs.append(recall_at_k(rel, len(gold[q.id]), 6))
            mrrs.append(mrr(rel))
        lat.sort()
        rows.append({**cfg, "recall@6": sum(recs) / len(recs), "mrr": sum(mrrs) / len(mrrs),
                     "recall_ci": bootstrap_ci(recs), "p50_ms": lat[len(lat) // 2],
                     "p95_ms": lat[int(0.95 * (len(lat) - 1))]})
    return pd.DataFrame(rows)


def one_factor(baseline: dict, axes: dict) -> list[dict]:
    out = [baseline]
    for axis, values in axes.items():
        out += [{**baseline, axis: v} for v in values if v != baseline[axis]]
    return out
```

For the small full grid over the axes that mattered, use
`[dict(zip(axes, v)) for v in itertools.product(*axes.values())]`.

### 13.5 pgvector / HNSW benchmark

**Question it answers:** "Why HNSW, and with which parameters?" Your corpus is small
(thousands of chunks), where exact search is already fast. So also run a **scale test**
with synthetic vectors (100k and 1M, same dimension) to show where HNSW starts to pay off.

Procedure:
1. Ground truth: exact top-k by sequential scan (`SET enable_indexscan = off`).
2. For each `(m, ef_construction)`: build the index and record build time and index size
   (`pg_relation_size`).
3. For each `ef_search ∈ {20, 40, 80, 160, 320}`: recall@10 vs exact, p50/p95 latency.
4. Repeat with `halfvec` (half the memory; check the recall cost).
5. Filtered queries: `iterative_scan` off vs `relaxed_order`. Show off returning < k rows
   under selective filters. This is the pgvector 0.8 feature that justifies the upgrade.

Deliverable: a recall-vs-latency curve plus a table. That is a strong README image.

### 13.6 CI gate (testcontainers)

```python
# tests/rag/conftest.py
import pytest
from testcontainers.postgres import PostgresContainer


@pytest.fixture(scope="session")
def pg_url():
    with PostgresContainer("pgvector/pgvector:0.8.0-pg17", driver=None) as pg:
        url = pg.get_connection_url()
        _migrate(url)                       # alembic upgrade head
        yield url
```

**CI config (fast and deterministic):** bge-small embeddings, recursive chunker, no
reranker, no LLM, a 30-query subset. Fail the build if Recall@6 drops more than 3
points below `eval/baseline.json`. Run the full ablation and RAGAS locally or nightly,
not on every push.

Tests worth having:
- `or_tsquery` on hostile input (`'"; DROP TABLE`, `C#`, empty) produces valid tsquery.
- Normalisation applied equally to index text and query (`C# minor` finds `csharp minor`).
- `ensure_vector_index` then `EXPLAIN` shows the HNSW index is used.
- Private source plus cloud enabled: the LLM factory still returns Ollama.
- The semantic cache does **not** hit for "bar 5" vs "bar 6".
- Graph: weak retrieval, then exactly one rewrite, then refuse (mock retriever).

---

## 14. Phase 10: MCP server (use your coach from Claude/Copilot/ChatGPT)

**Why:** this connects directly to the MCP work on your resume. The same retrieval
service becomes a tool any MCP client can call. Keep it **read-only**, run it over
**stdio**, and expose public sources only unless a flag is set.

```python
# rag/mcp_server.py
from __future__ import annotations

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("coreguitar")
_rt = None                                    # RagRuntime, created on first call


async def runtime():
    global _rt
    if _rt is None:
        from .runtime import RagRuntime
        _rt = await RagRuntime.create(public_only=True)
    return _rt


@mcp.tool()
async def search_guitar_knowledge(query: str, k: int = 5) -> list[dict]:
    """Search licensed guitar technique, theory and tone notes. Returns cited passages."""
    rt = await runtime()
    hits = await rt.search(query[:500], k=max(1, min(k, 10)))
    return [{"chunk_id": h.chunk_id, "title": h.title, "text": h.text[:1200],
             "license": h.license, "attribution": h.attribution} for h in hits]


@mcp.tool()
async def ask_about_take(take_id: str, question: str) -> dict:
    """Ask the coach about one analysed take. Answers are grounded in that take's findings."""
    rt = await runtime()
    return await rt.ask(question[:500], take_id=take_id)     # validates id, verifies answer


if __name__ == "__main__":
    mcp.run()          # stdio
```

`ask_about_take` reads private data (your recording), so register this server only in
local clients. Document that in the README.

---
## 15. UI, delivery plan, resume and interview prep

### 15.1 UI (reuse v1 Phase 11)

- Read the SSE stream with `fetch` + `ReadableStream` (EventSource cannot POST). Render
  progress stages as a compact stepper: *route → search → rerank → write → check*.
- Each citation chip `[C123]` opens the source title, license and attribution, and for
  take findings **seeks the audio player to the evidence range** (v1). That interaction
  is the demo moment.
- A "Why this answer?" drawer shows the per-ranker ranks (`ranks` JSON from SQL), the
  rerank score, and which sentences the verifier removed. Debug value for you; a
  transparency story for interviews.
- Keep the deterministic v1 coach visible when RAG is not installed.

### 15.2 Delivery plan (commit by commit)

| # | Commit | Done when |
|---|---|---|
| 1 | `rag: compose + extras + settings` | `docker compose up` healthy; core install unchanged |
| 2 | `rag: alembic schema` | `alembic upgrade head` on empty DB; testcontainers fixture green |
| 3 | `rag: loaders + text normalisation` | Unit tests for `lexical()`, GP loader on your own file |
| 4 | `rag: chunkers` | Golden tests: offsets round-trip, no chunk > max tokens, semantic break log |
| 5 | `rag: embeddings + cache + ingest (COPY)` | Re-ingest of unchanged corpus does zero embeds |
| 6 | `rag: hnsw index mgmt` | `EXPLAIN` shows index scan |
| 7 | `rag: hybrid sql + rerank + mmr + parents` | Retrieval gold baseline recorded |
| 8 | `rag: langgraph coach` | Graph tests incl. rewrite→refuse path |
| 9 | `rag: sse api + caches + worker` | p95 measured; cache tests green |
| 10 | `rag: tracing` | Phoenix shows a full request tree |
| 11 | `rag: eval + ablation + hnsw bench + CI gate` | README tables and plots |
| 12 | `rag: mcp server` | Works from one MCP client |
| 13 | `ui: streaming coach + citations` | Demo GIF |

Aim for 3–5 weeks of evenings. **Stop after commit 7 and measure** before building the
graph; if retrieval is weak, no orchestration will fix it.

### 15.3 Resume entry (fill the XX only with measured numbers)

```latex
\resumeProjectHeading
  {\textbf{CoreGuitar -- Local-First RAG Practice Coach} $|$ \emph{Python, FastAPI, PostgreSQL/pgvector, LangGraph, Ollama, Redis, Phoenix}}{}
\resumeItemListStart
  \resumeItem{Built a hybrid retriever in a \textbf{single SQL query} fusing pgvector HNSW, Postgres full-text and finding-tag ranks with RRF, plus cross-encoder reranking and MMR; lifted Recall@6 from \textbf{0.XX to 0.XX} on a \textbf{XXX-query} labelled set.}
  \resumeItem{Benchmarked \textbf{4 chunking strategies} (sliding window, recursive, semantic, parent-child) and \textbf{3 embedding models}; semantic + parent-child improved nDCG@6 by \textbf{XX points} at \textbf{XX ms} p95.}
  \resumeItem{Orchestrated a bounded corrective-RAG graph in \textbf{LangGraph} (route, rewrite once, grade, verify citations, refuse), reaching \textbf{XX\% faithfulness} (RAGAS, judge calibrated at $\kappa$=0.XX) and \textbf{XX\%} refusal accuracy.}
  \resumeItem{Tuned HNSW (m, ef\_search, halfvec, iterative scan) to \textbf{0.XX recall@10 at XX ms} on 1M vectors; served via FastAPI SSE with Redis and entity-guarded semantic caching, Phoenix tracing, and an \textbf{MCP} tool server.}
\resumeItemListEnd
```

Drop MedQuery and the "Pinecone" skill entry once this ships; add `pgvector, LangGraph,
RAGAS, Redis, OpenTelemetry` to Skills. **Never put a number you didn't measure.**

### 15.4 Interview questions you should be ready for

| Question | What a strong answer covers |
|---|---|
| Why pgvector instead of Pinecone? | Data size, transactional consistency with chunks/metadata, hybrid in one query, no network hop, cost; when you *would* switch (≫10M vectors, multi-tenant scale, managed ops) |
| How does HNSW work; what do m / ef_search do? | Layered proximity graph; degree vs memory; ef_search vs recall/latency; your measured curve |
| What happens with filters + ANN? | Post-filtering can return < k; pgvector 0.8 iterative scan; partial indexes per model |
| Why did semantic chunking win (or not)? | Your numbers, with CIs; cost of breakpoint embedding; when sliding window is better |
| Why RRF instead of score fusion? | Scores are on incomparable scales; RRF uses ranks; k=60 damping |
| Why a cross-encoder and why only top 24? | Joint attention vs independent vectors; O(k) cost; timeout fallback |
| How do you know the judge is right? | Calibration vs human labels, κ, stronger judge, temperature 0 |
| Semantic cache risks? | Near-miss queries (bar 5 vs 6), entity guard, scope/version keys, TTL |
| Privacy design? | Private flag at source level, cloud gating after retrieval, trace content stripping |
| What would you do with 10× traffic? | Pool sizing, reranker on GPU/batching, read replicas, cache hit rate, async ingestion |

### 15.5 Performance checklist

- [ ] Pool connections; `register_vector_async` in `configure`; never connect per request.
- [ ] One hybrid SQL round-trip; repeat the index's exact cast + `WHERE model =`.
- [ ] `SET LOCAL`-scoped `ef_search` / `iterative_scan` via `set_config(..., true)`.
- [ ] `COPY ... FORMAT BINARY` for bulk embeddings; create HNSW **after** the load; `ANALYZE`.
- [ ] Embedding cache by (model, sha); re-ingest is incremental.
- [ ] Models loaded once (lifespan), warmed with one dummy call, `lru_cache`d.
- [ ] Heavy CPU work in `asyncio.to_thread`, behind a semaphore; timeouts with graceful fallback.
- [ ] Parallel query variants with `asyncio.gather`; stop on client disconnect.
- [ ] Exact cache → semantic cache → graph; cache only verified answers.
- [ ] Bounded graph: ≤ 1 rewrite, per-node timeouts.
- [ ] Measure p50/p95 per stage in Phoenix before optimising anything.

### 15.6 The "kitchen sink" warning

The goal is not "uses 14 tools". It is **each tool justified by a measurement**. If
the ablation shows HyDE doesn't help your corpus, keep the code, report the negative
result, and leave it off by default. "I tried X, measured it, and turned it off" is one
of the most senior-sounding sentences in an interview.
