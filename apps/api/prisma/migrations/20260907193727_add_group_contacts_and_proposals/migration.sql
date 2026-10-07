-- CreateTable
CREATE TABLE "GroupContact" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupProposal" (
    "id" SERIAL NOT NULL,
    "dealId" INTEGER NOT NULL,
    "groupContactId" INTEGER,
    "productIds" INTEGER[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusNote" TEXT,
    "statusUpdatedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupProposalAttachment" (
    "id" SERIAL NOT NULL,
    "groupProposalId" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupProposalAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupProposalNote" (
    "id" SERIAL NOT NULL,
    "groupProposalId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupProposalNote_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "GroupContact" ADD CONSTRAINT "GroupContact_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposal" ADD CONSTRAINT "GroupProposal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposal" ADD CONSTRAINT "GroupProposal_groupContactId_fkey" FOREIGN KEY ("groupContactId") REFERENCES "GroupContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposal" ADD CONSTRAINT "GroupProposal_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposalAttachment" ADD CONSTRAINT "GroupProposalAttachment_groupProposalId_fkey" FOREIGN KEY ("groupProposalId") REFERENCES "GroupProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposalNote" ADD CONSTRAINT "GroupProposalNote_groupProposalId_fkey" FOREIGN KEY ("groupProposalId") REFERENCES "GroupProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupProposalNote" ADD CONSTRAINT "GroupProposalNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
