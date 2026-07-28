// Minimal backend for the AI command bar.
//
// Why this exists: the Anthropic API key must never be shipped to the
// browser. This tiny Express server holds the key, calls the Anthropic
// Messages API with tool definitions, and forwards Claude's response
// (text + tool_use blocks) straight to the frontend for dispatch.
//
// Run:
//   cd server
//   npm install
//   ANTHROPIC_API_KEY=sk-ant-... npm start
//
// The frontend expects this running on http://localhost:8787 by default
// (see VITE_API_BASE_URL in the Vite app's .env).

import express from 'express'
import cors from 'cors'

const PORT = process.env.PORT || 8787
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const API_KEY = process.env.ANTHROPIC_API_KEY

if (!API_KEY) {
  console.warn(
    '[warn] ANTHROPIC_API_KEY is not set. Set it in your environment before starting this server.'
  )
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const COLOR_ENUM = ['original', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']

// One tool per action App.jsx already supports. Descriptions do the
// prompting here — Claude reads these directly, no separate instructions
// needed for what each one does.
const TOOLS = [
  {
    name: 'select_muscle',
    description: 'Select a muscle without moving the camera.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'focus_muscle',
    description: 'Select a muscle and move the camera to frame it.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'hide_muscle',
    description: 'Hide a muscle from view.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'show_muscle',
    description: 'Unhide a previously hidden muscle.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'set_muscle_color',
    description: "Set a muscle's color.",
    input_schema: {
      type: 'object',
      properties: { muscle: { type: 'string' }, color: { type: 'string', enum: COLOR_ENUM } },
      required: ['muscle', 'color'],
    },
  },
  {
    name: 'reset_muscle_color',
    description: "Reset a muscle to its original color.",
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'add_to_isolated',
    description: 'Add a muscle to the isolation list.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'remove_from_isolated',
    description: 'Remove a muscle from the isolation list.',
    input_schema: { type: 'object', properties: { muscle: { type: 'string' } }, required: ['muscle'] },
  },
  {
    name: 'set_isolate_mode',
    description: "Turn 'render isolated only' mode on or off.",
    input_schema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
  },
  {
    name: 'clear_isolated_list',
    description: 'Empty the isolation list.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'show_all_muscles',
    description: 'Unhide every hidden muscle.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deselect_muscle',
    description: 'Clear the current muscle selection.',
    input_schema: { type: 'object', properties: {} },
  },
]

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name))

function buildSystemPrompt(muscles) {
  return `You control a 3D muscle anatomy viewer. Use the provided tools to carry out the user's \
instruction — call one tool per action needed. For a group request (e.g. "hamstrings", \
"everything on the left arm"), call the matching tool once per muscle in the list below. \
"muscle" arguments must exactly match a name from this list (case-insensitive) — never invent one; \
skip anything with no plausible match. Also give a short (under ~15 words) plain-text reply \
confirming what you did.

Muscle list (${muscles.length} names):
${JSON.stringify(muscles)}`
}

// Keeps only tool_use blocks with a name we actually defined, and drops
// unexpected input fields — cheap insurance against a malformed response.
function sanitizeContent(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => {
    if (block.type === 'text') return true
    if (block.type === 'tool_use') return TOOL_NAMES.has(block.name)
    return false
  })
}

app.post('/api/interpret', async (req, res) => {
  const { command, muscles } = req.body || {}

  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'Missing "command" string in request body.' })
  }
  if (!Array.isArray(muscles) || muscles.length === 0) {
    return res.status(400).json({ error: 'Missing "muscles" list in request body.' })
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(muscles),
        tools: TOOLS,
        messages: [{ role: 'user', content: command }],
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Anthropic API error:', response.status, errText)
      return res.status(502).json({ error: 'The AI service returned an error.' })
    }

    const data = await response.json()
    return res.json({ content: sanitizeContent(data.content) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Unexpected server error.' })
  }
})

app.listen(PORT, () => {
  console.log(`AI command server listening on http://localhost:${PORT}`)
})