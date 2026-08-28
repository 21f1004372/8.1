const express = require('express');
const { processCorpus } = require('./corpus');

const app = express();

app.use(express.json({ limit: '100mb' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  next();
});

app.post('/build-corpus', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const { policy, objects } = body;
  
  // Stricter request validation:
  // policy must be present, must be an object (not null, not array)
  // objects must be an array
  if (
    policy === undefined || 
    policy === null || 
    typeof policy !== 'object' || 
    Array.isArray(policy) || 
    !Array.isArray(objects)
  ) {
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
