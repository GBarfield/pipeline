-- New users choose their own password from a welcome email, so it starts empty.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AccountLink" ADD COLUMN     "tokenEnc" BYTEA;
