---
name: web-studio-frontend
description: 'Build or modify the coreguitar React 19 + TypeScript + Vite studio UI in web/src (App, ExercisePicker, Recorder, Uploader, TakeReview, Results, session reducer, audio recorder/worklet/WAV encoding) and its Vitest and Playwright tests. Use when adding UI features, changing the recording flow, fixing a11y, writing *.test.ts(x) or e2e/*.spec.ts, or when e2e coverage drops below 80%.'
---

# Web studio frontend

Stack: React 19, TypeScript 5 (very strict), Vite, Vitest + Testing Library (jsdom), Playwright + axe, ESLint (typescript-eslint).
No UI library, no router, no state library, no CSS framework — plain components, `useReducer`, and [style.css](../../../web/src/style.css).
Don't add dependencies for things the codebase already does by hand.

## TypeScript rules that bite

[tsconfig.json](../../../web/tsconfig.json) enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`. ESLint enforces `consistent-type-imports`.

- `import type { Take } from "./api";` for types — separate from value imports.
- Indexed values are `T | undefined`; narrow before use.
- Optional props: omit the key instead of passing `undefined` (`...(signal ? { signal } : {})`).
- Index-signature objects: `value["key"]`, not `value.key`.
- Never use `any`, `@ts-ignore`, or `eslint-disable`; `unknown` + type guards instead.

## Architecture

- **State**: [session.ts](../../../web/src/session.ts) `sessionReducer` with `phase`
  (`select_exercise → capture → uploading → validating → analyzing → results`). Add a `SessionEvent` variant + reducer
  case rather than ad-hoc `useState` for flow state; the `switch` must stay exhaustive.
- **Server calls** only through `api` in [api.ts](../../../web/src/api.ts) (see `local-api-contract` skill). Long operations
  use `AbortController`; cancel server work on unmount (see `App.tsx` cleanup effect).
- **Audio** ([audio/](../../../web/src/audio)): PCM via AudioWorklet (`pcm-recorder.worklet.ts`) → mono PCM16 WAV (`wav.ts`), not
  MediaRecorder. Request EC/NS/AGC off; start the click only after the first captured buffer; 180 s cap; device loss → partial take with warning.
- **Honest UI copy**: quality and re-record advice first; causes labelled "Possible causes (not measured)", drills "Drill (suggestion)";
  free mode never says "mistake". No scores.

## Accessibility (WCAG 2.2 AA, axe-gated)

- Each phase moves focus to its heading (`heading.current?.focus()` on `session.phase` change).
- Sections use `aria-labelledby` pointing at their `h2`; buttons ≥ 44px; visible `:focus-visible` outline.
- Query tests by role/label (`getByRole('button', { name })`), which doubles as an a11y check.

## Tests

- Unit: co-located `*.test.ts(x)`; import `render`, `screen`, etc. from [test-utils.tsx](../../../web/src/test-utils.tsx)
  (`render()` also returns a `userEvent` instance). `afterEach(() => { cleanup(); vi.restoreAllMocks(); })`.
  Use real fixtures where possible (`tests/golden/late.json` via `parseEnvelope`).
- E2E: [e2e/studio.spec.ts](../../../web/e2e/studio.spec.ts) against the isolated server (port 8767) with a fake mic
  playing `e2e/.generated/findings.wav`. Reuse its `select`, `upload`, `submit`, `confident` helpers; keep the axe test passing.
- `npm run e2e` instruments the build and enforces **≥ 80%** statements/branches/functions/lines. If it fails midway,
  run `npm --prefix web run build` to restore the uninstrumented build.
- Files excluded from coverage: `*.test.*`, `test-utils.tsx`, `main.tsx`, `*.worklet.ts` (keep `vite.config.ts` lists in sync).

## Commands

```bash
npm run typecheck && npm run lint && npm run test:frontend
npm --prefix web exec -- vitest run src/Results.test.tsx
npm run e2e        # needs: npm --prefix web exec -- playwright install chromium
```

Match the quote style of the file you edit (components/api use double quotes, tests single quotes); there is no Prettier config.
