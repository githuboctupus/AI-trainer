// Minimal backend for the AI command bar.
//
// The Anthropic API key must stay on the server. This Express app receives
// anatomy commands from the frontend, asks Claude to translate them into
// supported tool calls, and returns the text/tool_use blocks to App.jsx.
//
// Run:
//   cd server
//   npm install
//   ANTHROPIC_API_KEY=sk-ant-... npm start
//
// The frontend uses http://localhost:8787 unless VITE_API_BASE_URL is set.
import express from 'express'
import cors from 'cors'

const PORT = process.env.PORT || 8787
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const API_KEY = process.env.ANTHROPIC_API_KEY

if (!API_KEY) {
  console.warn(
    '[warn] ANTHROPIC_API_KEY is not set. Set it before starting the server.',
  )
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const COLOR_ENUM = [
  'original',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
]

const structureInput = {
  type: 'object',
  properties: {
    structure: {
      type: 'string',
      description: 'Exact anatomy structure name supplied by the application.',
    },
  },
  required: ['structure'],
}

const muscleInput = {
  type: 'object',
  properties: {
    muscle: {
      type: 'string',
      description: 'Exact muscle name supplied by the application.',
    },
  },
  required: ['muscle'],
}

const TOOLS = [
  // Anatomy-wide tools used for bones, muscles, joints, ligaments, and other
  // joint structures.
  {
    name: 'select_structure',
    description: 'Select one anatomy structure without moving the camera.',
    input_schema: structureInput,
  },
  {
    name: 'focus_structure',
    description: 'Select one anatomy structure and move the camera to frame it.',
    input_schema: structureInput,
  },
  {
    name: 'hide_structure',
    description: 'Hide one anatomy structure.',
    input_schema: structureInput,
  },
  {
    name: 'show_structure',
    description: 'Show one previously hidden anatomy structure.',
    input_schema: structureInput,
  },
  {
    name: 'set_structure_color',
    description: 'Set the display color of one anatomy structure.',
    input_schema: {
      type: 'object',
      properties: {
        structure: structureInput.properties.structure,
        color: { type: 'string', enum: COLOR_ENUM },
      },
      required: ['structure', 'color'],
    },
  },
  {
    name: 'reset_structure_color',
    description: 'Restore one anatomy structure to its original color.',
    input_schema: structureInput,
  },
  {
    name: 'add_to_selected',
    description: 'Add one anatomy structure to the selected/isolation list.',
    input_schema: structureInput,
  },
  {
    name: 'remove_from_selected',
    description: 'Remove one anatomy structure from the selected/isolation list.',
    input_schema: structureInput,
  },
  {
    name: 'set_isolate_mode',
    description: "Turn 'show only selected' isolation mode on or off.",
    input_schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
  },
  {
    name: 'clear_selected_list',
    description: 'Remove every structure from the selected/isolation list.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'show_all_structures',
    description: 'Unhide every hidden anatomy structure.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deselect_structure',
    description: 'Clear the current anatomy structure selection.',
    input_schema: { type: 'object', properties: {} },
  },

  // Legacy muscle tools remain available so old prompts, examples, and older
  // frontend versions continue to work.
  {
    name: 'select_muscle',
    description: 'Select a muscle without moving the camera.',
    input_schema: muscleInput,
  },
  {
    name: 'focus_muscle',
    description: 'Select a muscle and move the camera to frame it.',
    input_schema: muscleInput,
  },
  {
    name: 'hide_muscle',
    description: 'Hide a muscle.',
    input_schema: muscleInput,
  },
  {
    name: 'show_muscle',
    description: 'Show a previously hidden muscle.',
    input_schema: muscleInput,
  },
  {
    name: 'set_muscle_color',
    description: "Set a muscle's display color.",
    input_schema: {
      type: 'object',
      properties: {
        muscle: muscleInput.properties.muscle,
        color: { type: 'string', enum: COLOR_ENUM },
      },
      required: ['muscle', 'color'],
    },
  },
  {
    name: 'reset_muscle_color',
    description: 'Restore a muscle to its original color.',
    input_schema: muscleInput,
  },
  {
    name: 'add_to_isolated',
    description: 'Add a muscle to the selected/isolation list.',
    input_schema: muscleInput,
  },
  {
    name: 'remove_from_isolated',
    description: 'Remove a muscle from the selected/isolation list.',
    input_schema: muscleInput,
  },
  {
    name: 'clear_isolated_list',
    description: 'Remove every structure from the selected/isolation list.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'show_all_muscles',
    description: 'Unhide every hidden muscle while leaving other categories unchanged.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deselect_muscle',
    description: 'Clear the current selection when it is a muscle.',
    input_schema: { type: 'object', properties: {} },
  },
]

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name))

function normalizeStructures(structures, muscles) {
  if (Array.isArray(structures) && structures.length > 0) {
    return structures
      .filter((item) => item && typeof item.name === 'string' && item.name.trim())
      .map((item) => ({
        name: item.name.trim(),
        category:
          typeof item.category === 'string' && item.category.trim()
            ? item.category.trim()
            : 'Structure',
      }))
  }

  // Compatibility with an older frontend that only sends muscle names.
  if (Array.isArray(muscles)) {
    return muscles
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => ({ name: name.trim(), category: 'Muscle' }))
  }

  return []
}

function buildSystemPrompt(structures) {
  const namesByCategory = structures.reduce((groups, structure) => {
    const category = structure.category || 'Structure'
    if (!groups[category]) groups[category] = []
    groups[category].push(structure.name)
    return groups
  }, {})

  return `You control a 3D anatomy viewer containing bones, muscles, joints, ligaments, and related structures.

Use the provided tools to perform the user's instruction. Use one tool call per individual action and per individual structure. For requests involving several structures or a group, call the appropriate tool once for every clear matching structure.

Prefer the generic *_structure tools for all new commands, including commands about muscles. The legacy *_muscle tools exist only for backward compatibility.

The "structure" argument must exactly match one name from the categorized list below, case-insensitively. Never invent a structure name. Use category words in the user's request to disambiguate similarly named items. If no plausible structure matches, do not issue a tool call for it.

Keep any plain-text confirmation brief, ideally under 15 words.

Available anatomy structures (${structures.length} total):
${JSON.stringify(namesByCategory)}`
}

function sanitizeContent(content) {
  if (!Array.isArray(content)) return []

  return content.filter((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return true
    if (block?.type === 'tool_use' && TOOL_NAMES.has(block.name)) return true
    return false
  })
}

app.post('/api/interpret', async (req, res) => {
  const { command, muscles, structures: requestedStructures } = req.body || {}

  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({
      error: 'Missing "command" string in request body.',
    })
  }

  const structures = normalizeStructures(requestedStructures, muscles)
  if (structures.length === 0) {
    return res.status(400).json({
      error: 'Missing "structures" or legacy "muscles" list in request body.',
    })
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY.',
    })
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
        system: buildSystemPrompt(structures),
        tools: TOOLS,
        messages: [{ role: 'user', content: command.trim() }],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Anthropic API error:', response.status, errorText)
      return res.status(502).json({
        error: 'The AI service returned an error.',
      })
    }

    const data = await response.json()
    return res.json({ content: sanitizeContent(data.content) })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      error: 'Unexpected server error.',
    })
  }
})

app.listen(PORT, () => {
  console.log(`AI command server listening on http://localhost:${PORT}`)
})
