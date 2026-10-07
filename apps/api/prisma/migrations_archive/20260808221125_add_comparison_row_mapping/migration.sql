-- CreateTable
CREATE TABLE "ComparisonRowMapping" (
    "id" SERIAL NOT NULL,
    "dealId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "aliasLabel" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComparisonRowMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComparisonRowMapping_dealId_productId_idx" ON "ComparisonRowMapping"("dealId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ComparisonRowMapping_dealId_productId_section_aliasLabel_key" ON "ComparisonRowMapping"("dealId", "productId", "section", "aliasLabel");

-- AddForeignKey
ALTER TABLE "ComparisonRowMapping" ADD CONSTRAINT "ComparisonRowMapping_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComparisonRowMapping" ADD CONSTRAINT "ComparisonRowMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
