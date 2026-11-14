import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import 'dotenv/config';
import { runLoadElections } from './etl/loadElections.ts';
import { runSyncCensusFromElections } from './etl/syncCensusFromElections.ts';
import { reconcileGroupCoverage } from './etl/reconcileCoverage.ts';
import { config } from './etl/config.ts';
import authRouter from './routes/auth.ts';
import usersRouter from './routes/users.ts';
import carriersRouter from './routes/carriers.ts';
import carrierContactsRouter from './routes/carrierContacts.ts';
import partnerContactsRouter from './routes/partnerContacts.ts';
import brokersRouter from './routes/brokers.ts';
import productsRouter from './routes/products.ts';
import groupsRouter from './routes/groups.ts';
import quotesRouter from './routes/quotes.ts';
import comparisonRouter from './routes/comparison.ts';
import dealsRouter from './routes/deals.ts';
import rfqsRouter from './routes/rfqs.ts';
import groupContactsRouter from './routes/groupContacts.ts';
import groupProposalsRouter from './routes/groupProposals.ts';
import triageRouter from './routes/triage.ts';
import benefitLinesRouter from './routes/benefitLines.ts';
import divisionsRouter from './routes/divisions.ts';
import commissionPeriodsRouter from './routes/commissionPeriods.ts';
import commissionReconciliationRouter from './routes/commissionReconciliation.ts';
import commissionStatementsRouter from './routes/commissionStatements.ts';
import reconciliationFiltersRouter from './routes/reconciliationFilters.ts';
import benefitsDocumentsRouter from './routes/benefitsDocuments.ts';
import benefitsReconciliationRouter from './routes/benefitsReconciliation.ts';
import employeeNavigatorRouter from './routes/employeeNavigator.ts';

const app = express();
// origin: true reflects the request's own Origin header (rather than '*'),
// which is required for credentials: true (cookies) to work at all. Covers
// both same-origin production (behind the IIS proxy) and cross-origin local
// dev (Vite on :5173 talking to the API on :3000).
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/api/benefit-lines', benefitLinesRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/carriers', carriersRouter);
app.use('/api/carriers/:carrierId/contacts', carrierContactsRouter);
app.use('/api/partner-contacts', partnerContactsRouter);
app.use('/api/brokers', brokersRouter);
app.use('/api/products', productsRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/groups/:groupId/deals', dealsRouter);
app.use('/api/deals/:dealId/quotes', quotesRouter);
app.use('/api/deals/:dealId/rfqs', rfqsRouter);
app.use('/api/groups/:groupId/contacts', groupContactsRouter);
app.use('/api/deals/:dealId/proposals', groupProposalsRouter);
app.use('/api/deals/:dealId/comparison', comparisonRouter);
app.use('/api/triage', triageRouter);
app.use('/api/divisions', divisionsRouter);
app.use('/api/groups/:groupId/commission-periods', commissionPeriodsRouter);
app.use('/api/commission-periods/:periodId', commissionReconciliationRouter);
app.use('/api/commission-statements', commissionStatementsRouter);
app.use('/api/reconciliation', reconciliationFiltersRouter);
app.use('/api/benefits-documents', benefitsDocumentsRouter);
app.use('/api/groups/:groupId/employee-navigator', employeeNavigatorRouter);
app.use('/api/groups/:groupId/benefits-reconciliation', benefitsReconciliationRouter);

// EN elections load + census sync - now an integral part of this service
// instead of separate Windows Task Scheduler entries. Polls every 15
// minutes for the EN downloader's completion flag, mirroring the old
// "BenAdmin Elections Loader" Task Scheduler task's own repetition
// interval - runLoadElections() already self-gates as a no-op (returns
// null) when the flag is missing or stale, so most ticks do nothing.
// Census sync only runs immediately after a load that actually loaded
// something, so it's always chained by real completion, never by a
// separately-guessed offset, and it never re-processes unchanged data.
//
// This is also the first time syncCensusFromElections has ever actually
// run in this environment - it existed as a file but had no Task
// Scheduler entry at all before this change (2026-08-22 finding).
//
// etlRunning guards against overlapping runs: if a tick is still in
// progress when the next one fires (this chain touches every
// EN-covered group and will only get slower as the database grows -
// exactly the concern that ruled out fixed-offset scheduling elsewhere
// in this pipeline), the next tick skips instead of racing the same
// files/DB rows.
//
// IMPORTANT: the old "BenAdmin Elections Loader" Windows Task Scheduler
// entry must be DISABLED (not left running) once this ships, or it will
// race this in-process scheduler over the same input files.
let etlRunning = false;
cron.schedule('*/15 * * * *', async () => {
  if (etlRunning) {
    console.log('[scheduled ETL] Previous run still in progress - skipping this tick.');
    return;
  }
  etlRunning = true;
  try {
        const loadSummary = await runLoadElections();
    if (loadSummary && loadSummary.filesLoaded > 0) {
      await runSyncCensusFromElections();
    }
    await reconcileGroupCoverage();
  } catch (err) {
    console.error('[scheduled ETL] Error in loadElections/syncCensusFromElections/reconcileGroupCoverage chain:', err);
  } finally {
    etlRunning = false;
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
  // One-time startup banner - answers "where does X actually live" up front
  // instead of needing a fresh round of log-guessing on every question.
  console.log('[startup] EN pipeline config:');
  console.log(`[startup]   inputDir                = ${config.inputDir}`);
  console.log(`[startup]   archiveDir              = ${config.archiveDir}`);
  console.log(`[startup]   failedDir               = ${config.failedDir}`);
  console.log(`[startup]   logDir                  = ${config.logDir}`);
  console.log(`[startup]   downloadFlagPath        = ${config.downloadFlagPath}`);
  console.log(`[startup]   downloadFlagMaxAgeHours = ${config.downloadFlagMaxAgeHours}`);
  console.log(`[startup]   dryRun                  = ${config.dryRun}`);
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbNameMatch = dbUrl.match(/\/([^/?]+)(\?|$)/);
  console.log(`[startup]   database                = ${dbNameMatch ? dbNameMatch[1] : '(unparseable)'}`);
});