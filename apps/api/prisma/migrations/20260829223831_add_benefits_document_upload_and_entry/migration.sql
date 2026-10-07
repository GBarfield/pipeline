-- CreateTable
CREATE TABLE "BenefitsDocumentUpload" (
    "id" SERIAL NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "divisionId" INTEGER NOT NULL,
    "documentType" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'processed',

    CONSTRAINT "BenefitsDocumentUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitsDocumentEntry" (
    "id" SERIAL NOT NULL,
    "uploadId" INTEGER NOT NULL,
    "divisionId" INTEGER NOT NULL,
    "groupId" INTEGER,
    "companyNameRaw" TEXT,
    "sourceFile" TEXT NOT NULL,
    "employeeName" TEXT,
    "carrierName" TEXT NOT NULL,
    "productId" INTEGER,
    "productLabel" TEXT,
    "planName" TEXT,
    "coverageTier" TEXT,
    "effectiveDate" DATE,
    "terminationDate" DATE,
    "status" TEXT,
    "rawRow" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenefitsDocumentEntry_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BenefitsDocumentUpload" ADD CONSTRAINT "BenefitsDocumentUpload_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitsDocumentEntry" ADD CONSTRAINT "BenefitsDocumentEntry_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "BenefitsDocumentUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitsDocumentEntry" ADD CONSTRAINT "BenefitsDocumentEntry_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitsDocumentEntry" ADD CONSTRAINT "BenefitsDocumentEntry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitsDocumentEntry" ADD CONSTRAINT "BenefitsDocumentEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
