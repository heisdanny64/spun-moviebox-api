// api/health.js
// Liveness check, no auth required — used by uptime monitors to keep the
// deployment warm (Vercel functions cold-start on Hobby plans after idle).

export default function handler(req, res) {
  res.status(200).json({ status: 'ok', service: 'spun-moviebox-relay', ts: Date.now() });
}
