const express = require('express');
const { processCorpus } = require('./corpus');

const app = express();

// Use express.json with a limit to handle large payloads
app.use(express.json({ limit: '100mb' }));

// Middleware to catch syntax errors in JSON payloads
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  next();
});

// POST /build-corpus endpoint
app.post('/build-corpus', (req, res) => {
  const body = req.body;
  if (!body) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const { policy, objects } = body;
  
  // Validation: A missing policy or non-array objects returns HTTP 400 with exactly {"error":"INVALID_INPUT"}
  if (policy === undefined || !Array.isArray(objects)) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  try {
    const result = processCorpus(body);
    return res.json(result);
  } catch (error) {
    console.error('Processing error:', error);
    return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Corpus service listening on port ${PORT}`);
});
