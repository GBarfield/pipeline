-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierMessage" (
    "id" SERIAL NOT NULL,
    "carrierId" INTEGER NOT NULL,
    "groupId" INTEGER,
    "templateId" INTEGER,
    "divisionId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentByUserId" INTEGER NOT NULL,
    "brokerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierMessageRecipient" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "carrierContactId" INTEGER,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "transport" TEXT,
    "providerId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "eventAt" TIMESTAMP(3),
    "eventDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierMessageRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CarrierMessage_carrierId_idx" ON "CarrierMessage"("carrierId");

-- CreateIndex
CREATE INDEX "CarrierMessage_createdAt_idx" ON "CarrierMessage"("createdAt");

-- CreateIndex
CREATE INDEX "CarrierMessageRecipient_messageId_idx" ON "CarrierMessageRecipient"("messageId");

-- CreateIndex
CREATE INDEX "CarrierMessageRecipient_providerId_idx" ON "CarrierMessageRecipient"("providerId");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessage" ADD CONSTRAINT "CarrierMessage_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessage" ADD CONSTRAINT "CarrierMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessage" ADD CONSTRAINT "CarrierMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessage" ADD CONSTRAINT "CarrierMessage_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessage" ADD CONSTRAINT "CarrierMessage_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessageRecipient" ADD CONSTRAINT "CarrierMessageRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CarrierMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMessageRecipient" ADD CONSTRAINT "CarrierMessageRecipient_carrierContactId_fkey" FOREIGN KEY ("carrierContactId") REFERENCES "CarrierContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
