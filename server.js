import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Validar environment variables
if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️ GROQ_API_KEY no configurada en .env');
}

// Rutas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Chat con Groq
app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature } = req.body;
  
  if (!process.env.GROQ_API_KEY) {
    return res.status(400).json({ error: 'API Key de Groq no configurada' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'mixtral-8x7b-32768',
        messages: messages,
        temperature: temperature || 0.3,
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error, details: error });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        res.write(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({ error: 'Error procesando solicitud', details: error.message });
  }
});

// API: Búsqueda web (usando DuckDuckGo)
app.post('/api/search', async (req, res) => {
  const { query, limit = 5 } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query requerida' });
  }

  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { timeout: 10000 }
    );

    const data = await response.json();
    const results = [
      ...data.Results,
      ...data.RelatedTopics
    ].filter(r => r.Text).slice(0, limit).map(r => ({
      title: r.FirstURL?.split('/')[2] || 'Web',
      snippet: r.Text,
      url: r.FirstURL || '#'
    }));

    res.json({ results, query });
  } catch (error) {
    console.error('Error en /api/search:', error);
    res.status(500).json({ error: 'Error en búsqueda', details: error.message });
  }
});

// API: Generar imagen con Replicate (opcional)
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !process.env.REPLICATE_API_KEY) {
    return res.status(400).json({ error: 'Prompt requerido o Replicate API Key no configurada' });
  }

  try {
    const response = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: '2e191859266f726216beec79f53f7fc3a6d3512c7cda285dd5ce542eaf389c18',
        input: { prompt }
      })
    });

    const prediction = await response.json();
    res.json(prediction);
  } catch (error) {
    console.error('Error en /api/generate-image:', error);
    res.status(500).json({ error: 'Error generando imagen', details: error.message });
  }
});

// API: Exportar chat como JSON
app.post('/api/export-chat', (req, res) => {
  const { messages, title } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Mensajes inválidos' });
  }

  const filename = `${title || 'chat'}_${new Date().toISOString().split('T')[0]}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({
    title,
    date: new Date().toISOString(),
    messages,
    version: '1.0'
  });
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    groqConfigured: !!process.env.GROQ_API_KEY
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Error interno del servidor', 
    message: err.message 
  });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`🔑 Groq API: ${process.env.GROQ_API_KEY ? '✅ Configurada' : '❌ No configurada'}`);
  console.log(`🔍 Búsqueda Web: ✅ Disponible (DuckDuckGo)`);
});
