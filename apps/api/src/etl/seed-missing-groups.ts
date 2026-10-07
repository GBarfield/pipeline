import { prisma } from "../lib/prisma.ts";

const NAMES = [
  "1 Stop General Contracting",
  "1-800 Radiator",
  "AARCO Wireless & Electrical Solutions",
  "AB Acquisitions dba Proper Vest",
  "AB3 Mechanical",
  "AC Owen Construction",
  "Acacia Information Technologies, LLC.",
  "CMIT Solutions of Round Rock",
  "Coffey Automotive",
  "Compere Construction",
  "Computer St. Louis",
  "Conserve-A-Watt Lighting, LLC",
  "Contender LLC",
  "Smart Karton",
  "SMART Management Schools",
  "Smoky Mountain",
  "SnapCom",
  "Southwest Networks",
  "Sport Clips",
  "Springs Public Schools Tennessee",
  "Srote and Co",
  "SS Stone & Design",
  "St. Anthony Academy",
  "ST. LOUIS COMPONENT REPAIR",
  "ST. LOUIS SCALE",
  "St. Louis Stars",
];

async function main() {
  for (const company of NAMES) {
    const existing = await prisma.group.findFirst({ where: { company } });
    if (existing) {
      console.log(`SKIP (already exists): ${company}`);
      continue;
    }
    const created = await prisma.group.create({ data: { company } });
    console.log(`CREATED #${created.id}: ${company}`);
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });