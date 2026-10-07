import json
from core import pdf_utils, profile_store

PDF_PATH = r"C:\multiproduct.pdf"
PROFILE_PATH = r"C:\Projects\benadmin\apps\bucket\carrier_profiles\mutual_of_omaha_united_of_omaha_life_insurance_company__age_banded__std.json"

text = pdf_utils.extract_text(PDF_PATH)
profile = json.load(open(PROFILE_PATH, encoding="utf-8"))
fp = profile["fingerprint"]
norm = profile_store._normalize(text)

print(f"Extracted text length: {len(text)} chars (normalized: {len(norm)} chars)")
print()
print("MUST_CONTAIN:")
for s in fp["must_contain"]:
    hit = profile_store._normalize(s) in norm
    print(f"  {'OK     ' if hit else 'MISSING'}  {s!r}")

print()
print("ANY_OF:")
for s in fp["any_of"]:
    hit = profile_store._normalize(s) in norm
    print(f"  {'OK     ' if hit else 'MISSING'}  {s!r}")

print()
result = profile_store.match(text, "age_banded", benefit_line="STD")
print(f"match() result: {'FOUND' if result else 'None (no match)'}")