import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function bool(name: string, defaultVal: boolean): boolean {
  const val = process.env[name];
  if (val === undefined) return defaultVal;
  return val.toLowerCase() === 'true';
}

export const config = {
  inputDir: required('EN_INPUT_DIR'),
  archiveDir: required('EN_ARCHIVE_DIR'),
  failedDir: required('EN_FAILED_DIR'),
  logDir: required('EN_LOG_DIR'),
  downloadFlagPath: required('EN_DOWNLOAD_COMPLETE_FLAG'),
  downloadFlagMaxAgeHours: Number(process.env.EN_DOWNLOAD_FLAG_MAX_AGE_HOURS ?? '12'),
  groupSimilarityThreshold: Number(process.env.GROUP_SIMILARITY_THRESHOLD ?? '0.6'),
  ssnPepper: process.env.SSN_PEPPER ?? '',
  storeSsnPlaintext: bool('STORE_SSN_PLAINTEXT', false),
  dryRun: bool('DRY_RUN', false),
};