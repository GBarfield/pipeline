-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totpFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totpLastStep" BIGINT,
ADD COLUMN     "totpLockedUntil" TIMESTAMP(3),
ADD COLUMN     "totpNeedsLink" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpNewEnc" BYTEA,
ADD COLUMN     "totpOnAt" TIMESTAMP(3),
ADD COLUMN     "totpSecretEnc" BYTEA;

-- CreateTable
CREATE TABLE "PendingSignIn" (
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingSignIn_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "AccountLink" (
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AccountLink_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "PendingSignIn_userId_idx" ON "PendingSignIn"("userId");

-- CreateIndex
CREATE INDEX "AccountLink_userId_idx" ON "AccountLink"("userId");

-- AddForeignKey
ALTER TABLE "PendingSignIn" ADD CONSTRAINT "PendingSignIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLink" ADD CONSTRAINT "AccountLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
