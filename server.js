import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lista de modelos recomendados y compatibles con Groq
const DEFAULT_GROQ_MODELS = [
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Máxima Inteligencia)' },
  { id: 'groq/compound', name: 'Groq Compound (Recomendado / Balanceado)' },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Ultra Rápido)' },
  { id: 'qwen/qwen3.6-27b', name: 'Qwen 3.6 27B (Razonamiento & Código)' },
  { id: 'groq/compound-mini', name: 'Groq Compound Mini (Ligero)' },
  { id: 'llama-3.3-70b-versatile', name: 'LLaMA 3.3 70B Versatile' },
  { id: 'llama-3.1-8b-instant', name: 'LLaMA 3.1 8B Instant' }
];

// Rutas base
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    groqConfigured: !!process.env.GROQ_API_KEY,
    nodeVersion: process.version
  });
});

// API: Listar modelos disponibles
app.get('/api/models', async (req, res) => {
  const apiKey = req.headers['x-groq-api-key'] || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.json({ models: DEFAULT_GROQ_MODELS });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      return res.json({ models: DEFAULT_GROQ_MODELS });
    }

    const data = await response.json();
    const chatModels = (data.data || [])
      .filter(m => !m.id.includes('whisper') && !m.id.includes('guard'))
      .map(m => ({
        id: m.id,
        name: m.id
      }));

    res.json({
      models: chatModels.length > 0 ? chatModels : DEFAULT_GROQ_MODELS
    });
  } catch (error) {
    res.json({ models: DEFAULT_GROQ_MODELS });
  }
});

// API: Chat con Groq (Streaming SSE)
app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature } = req.body;
  const apiKey = req.headers['x-groq-api-key'] || process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error: 'API Key de Groq no configurada en el servidor ni provista en la solicitud.'
    });
  }

  const selectedModel = model || 'openai/gpt-oss-120b';
  const selectedTemp = typeof temperature === 'number' ? temperature : 0.3;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: messages || [],
        temperature: selectedTemp,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorText;
      } catch (e) {}
      return res.status(response.status).json({ error: errorMessage });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (response.body.getReader) {
      // Web Streams standard
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
    } else if (response.body[Symbol.asyncIterator]) {
      // Node.js async iterator
      for await (const chunk of response.body) {
        res.write(chunk);
      }
    } else {
      // Stream pipe
      response.body.pipe(res);
      return;
    }

    res.end();
  } catch (error) {
    console.error('Error en /api/chat:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error procesando solicitud', details: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// API: Búsqueda web
app.post('/api/search', async (req, res) => {
  const { query, limit = 5 } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query de búsqueda requerida' });
  }

  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { signal: AbortSignal.timeout(10000) }
    );

    const data = await response.json();
    const rawResults = [
      ...(data.Results || []),
      ...(data.RelatedTopics || [])
    ];

    const results = rawResults
      .flatMap(r => {
        if (r.Topics) return r.Topics;
        return [r];
      })
      .filter(r => r && (r.Text || r.Result))
      .slice(0, limit)
      .map(r => ({
        title: r.FirstURL ? (r.FirstURL.split('/')[2] || 'Web') : 'Información',
        snippet: r.Text || r.Result || '',
        url: r.FirstURL || '#'
      }));

    res.json({ results, query });
  } catch (error) {
    console.error('Error en /api/search:', error);
    res.status(500).json({ error: 'Error en búsqueda web', details: error.message });
  }
});

// API: Generar imagen
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  const replicateKey = req.headers['x-replicate-api-key'] || process.env.REPLICATE_API_KEY;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt de imagen requerido' });
  }

  // Si hay clave de Replicate, intentamos con Replicate
  if (replicateKey) {
    try {
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${replicateKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: '2e191859266f726216beec79f53f7fc3a6d3512c7cda285dd5ce542eaf389c18',
          input: { prompt }
        })
      });

      const prediction = await response.json();
      return res.json(prediction);
    } catch (error) {
      console.warn('Replicate error, fallback to pollinations:', error.message);
    }
  }

  // Fallback a Pollinations gratuito
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&nologo=true`;
  res.json({ imageUrl, prompt, source: 'pollinations' });
});

// API: Exportar chat
app.post('/api/export-chat', (req, res) => {
  const { messages, title, user } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Mensajes inválidos' });
  }

  const safeTitle = (title || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeTitle}_${new Date().toISOString().split('T')[0]}.json`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({
    title: title || 'Conversación Tutor IA',
    user: user || 'Invitado',
    date: new Date().toISOString(),
    messages,
    version: '1.0'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error no capturado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: err.message
  });
});

// Iniciar servidor local o en plataformas VPS/Render/Railway
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🎓 TUTOR IA STUDIO PRO - EN LÍNEA`);
    console.log(`🌐 Servidor: http://localhost:${PORT}`);
    console.log(`🔑 Groq Key: ${process.env.GROQ_API_KEY ? '✅ Configurada en servidor' : '⚠️ No configurada en .env'}`);
    console.log(`🚀 Modo: ${process.env.NODE_ENV || 'production'}`);
    console.log(`========================================\n`);
  });
}

export default app;
