import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import coverageLibrary from 'istanbul-lib-coverage';
import reportLibrary from 'istanbul-lib-report';
import reports from 'istanbul-reports';

if (process.argv.includes('--clean')) {
  if (existsSync('coverage/e2e')) {
    for (const file of readdirSync('coverage/e2e')) {
      if (/^[0-9a-f-]{36}\.json$/.test(file)) unlinkSync(`coverage/e2e/${file}`);
    }
  }
} else {
  const coverage = coverageLibrary.createCoverageMap({});
  for (const file of readdirSync('coverage/e2e')) {
    coverage.merge(JSON.parse(readFileSync(`coverage/e2e/${file}`, 'utf8')));
  }
  const context = reportLibrary.createContext({ dir: 'coverage/e2e-report', coverageMap: coverage });
  reports.create('text').execute(context);
  reports.create('json').execute(context);
  const summary = coverage.getCoverageSummary();
  if (['lines', 'statements', 'functions', 'branches'].some(metric => summary[metric].pct < 80)) {
    throw new Error('Browser behavioral coverage must reach 80% in every metric.');
  }
}
