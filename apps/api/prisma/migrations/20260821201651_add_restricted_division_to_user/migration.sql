-- AlterTable
ALTER TABLE "User" ADD COLUMN     "restrictedDivisionId" INTEGER;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restrictedDivisionId_fkey" FOREIGN KEY ("restrictedDivisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;
