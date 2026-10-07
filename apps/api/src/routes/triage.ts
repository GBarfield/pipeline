// Destination: apps/api/src/routes/triage.ts  (NEW FILE)
//
// Passthrough to the Bucket's /triage endpoint (the temporary diagnostic route
// added earlier in core/claude_client.py + app.py). Not scoped to a Group or
// Deal — triage runs against a raw PDF with no persistence, so there's nothing
// in Postgres to attach it to. Mirrors quotes.ts's upload-forwarding pattern
// (multer memoryStorage -> FormData -> fetch to the Bucket) but never creates
// a database row — the whole point is to inspect a document without
// committing to anything.
//
// Safe to delete this one file (plus its one import line and one mount line
// in index.ts, and the matching Triage.tsx page) once the triage panel has
// served its purpose.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.ts';

const router = Router();

router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }, // matches the Bucket's own MAX_CONTENT_LENGTH
});

// Same env var + default quotes.ts already uses to reach the Bucket.
const BUCKET_URL = process.env.BUCKET_URL || 'http://127.0.0.1:5001';

// POST /api/triage
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);

    const bucketRes = await fetch(`${BUCKET_URL}/triage`, {
      method: 'POST',
      body: formData,
    });

    let bucketJson: any;
    try {
      bucketJson = await bucketRes.json();
    } catch {
      return res.status(502).json({ error: 'Bucket returned a non-JSON response' });
    }

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Triage failed' });
    }

    res.json(bucketJson);
  } catch (err) {
    console.error('Failed to reach Bucket /triage:', err);
    res.status(502).json({ error: 'Failed to reach the Bucket' });
  }
});

export default router;