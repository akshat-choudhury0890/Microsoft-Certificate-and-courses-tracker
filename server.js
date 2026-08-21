const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Fetch Domains
app.get('/api/domains', async (req, res) => {
  try {
    const [domains] = await db.query('SELECT ID, Course, Descrip FROM Domains');
    res.json(domains);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Fetch User Progress and Dynamically Resolve Graph Statuses
app.get('/api/users/:userId/progress/:domainId', async (req, res) => {
  const { userId, domainId } = req.params;

  try {
    // Query certifications for the specific domain
    const [certs] = await db.query(
      'SELECT ID, domain_id, cert_name, Descrip, Learn_url FROM Certifications WHERE domain_id = ?', 
      [domainId]
    );

    // Query user completion state
    const [completedRows] = await db.query(
      'SELECT cert_id FROM user_progress WHERE user_id = ? AND completed = TRUE', 
      [userId]
    );
    const completedSet = new Set(completedRows.map(r => r.cert_id));

    // Query prerequisite dependency graph
    const [prereqRows] = await db.query('SELECT cert_id, prerequisite_id FROM prerequisites');
    const prereqMap = {};
    prereqRows.forEach(({ cert_id, prerequisite_id }) => {
      if (!prereqMap[cert_id]) prereqMap[cert_id] = [];
      prereqMap[cert_id].push(prerequisite_id);
    });

    // Compute status state machine per certification
    const response = certs.map(cert => {
      let status = 'locked';

      if (completedSet.has(cert.ID)) {
        status = 'completed';
      } else {
        const requiredPrereqs = prereqMap[cert.ID] || [];
        const hasSatisfiedPrereqs = requiredPrereqs.every(prereqId => completedSet.has(prereqId));
        if (hasSatisfiedPrereqs) status = 'available';
      }

      return { ...cert, status };
    });

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Mutate User Progress (With Server-Side Validation)
app.post('/api/users/:userId/progress', async (req, res) => {
  const { userId } = req.params;
  const { cert_id } = req.body;

  try {
    // Validate prerequisites on backend to prevent forced execution
    const [prereqs] = await db.query(
      'SELECT prerequisite_id FROM prerequisites WHERE cert_id = ?', 
      [cert_id]
    );
    const [userDone] = await db.query(
      'SELECT cert_id FROM user_progress WHERE user_id = ? AND completed = TRUE', 
      [userId]
    );
    const completedSet = new Set(userDone.map(r => r.cert_id));

    const unfulfilledPrereqs = prereqs.filter(p => !completedSet.has(p.prerequisite_id));
    if (unfulfilledPrereqs.length > 0) {
      return res.status(400).json({ 
        error: 'Forbidden: Certification prerequisites have not been fulfilled.' 
      });
    }

    // Upsert completion record into database
    await db.query(
      `INSERT INTO user_progress (user_id, cert_id, completed) 
       VALUES (?, ?, TRUE) 
       ON DUPLICATE KEY UPDATE completed = TRUE`,
      [userId, cert_id]
    );

    res.json({ message: 'Progress updated successfully.', cert_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. LLM Educational Explanations with Fallback Mechanism
app.post('/api/ai/explain-next', async (req, res) => {
  const { current_cert, completed_certs } = req.body;
  
  const fallback = {
    cert_id: current_cert,
    explanation: "This certification is now unlocked based on your completed prerequisite trajectory."
  };

  try {
    const prompt = `You are an academic advisor. The deterministic application logic determined that certification "${current_cert}" is unlocked because the user completed: [${completed_certs.join(', ')}]. Provide a 1-2 sentence encouraging pedagogical explanation of why this next certification builds logically on their skills. Do not choose or re-rank certifications.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    res.json({
      cert_id: current_cert,
      explanation: response.text.trim() || fallback.explanation
    });
  } catch (err) {
    // Defensive failure handling: Return static fallback on API timeout/rate limits
    res.json(fallback);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));