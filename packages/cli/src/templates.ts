export const CONFIG_TEMPLATE = `# Memento project configuration
name: my-app

# Where tests start when a test has no \`url\`. Relative URLs resolve against it.
baseUrl: http://localhost:3000

include: ["tests/**/*.test.yaml"]

environments:
  - name: staging
    baseUrl: https://staging.example.com
    variables:
      QA_EMAIL: qa@example.com

ai:
  # Bring your own models. Keys come from environment variables, never commit them.
  providers:
    anthropic:
      type: anthropic
      apiKey: \${ANTHROPIC_API_KEY}
    # openai:
    #   type: openai
    #   apiKey: \${OPENAI_API_KEY}
    # google:
    #   type: google
    #   apiKey: \${GOOGLE_GENERATIVE_AI_API_KEY}
    # Local models through Ollama / LM Studio / vLLM (OpenAI-compatible API):
    # local:
    #   type: openai-compatible
    #   baseURL: http://localhost:11434/v1
    #   vision: false   # set true for vision models such as qwen2.5-vl
    # OpenRouter gives access to hundreds of models with one key:
    # openrouter:
    #   type: openai-compatible
    #   baseURL: https://openrouter.ai/api/v1
    #   apiKey: \${OPENROUTER_API_KEY}

  # \`provider:model\`. Pick per agent; a list means "fall back in order".
  models:
    default: anthropic:claude-sonnet-5-5
    # Locator and assertion calls are frequent and simple — a fast model is ideal.
    locator: anthropic:claude-haiku-5-5
    assertion: anthropic:claude-haiku-5-5
    # act: [anthropic:claude-opus-5-5, openrouter:openai/gpt-5]

  vision: true
  failureRecovery: false

browser:
  type: chromium        # chromium | firefox | webkit
  headless: true
  viewport: { width: 1280, height: 800 }

trace: retain-on-failure  # open with: memento trace <path>
`;

export const EXAMPLE_TEST = `fileType: memento/test/v1
id: example-search
description: Search the Playwright docs
url: https://playwright.dev
steps:
  # Preset steps: explicit, reviewable, element found by description and cached.
  - click: the Search button in the header
  - type:
      text: locators
      into: the search input
  # An AI check, judged against the page.
  - assert: Search results mentioning 'Locators' are shown
  # An AI action: the agent figures out the clicks.
  - act:
      goal: Open the Locators documentation page from the results
      postcondition: The page heading says 'Locators'
`;

export const EXAMPLE_MODULE = `fileType: memento/module/v1
id: log-in
name: Log in
parameters:
  - name: EMAIL
    default: { javascript: env.QA_EMAIL }
  - name: PASSWORD
    default: { javascript: env.QA_PASSWORD }
steps:
  - fill:
      text: "{{ env.EMAIL }}"
      into: the Email field
  - fill:
      text: "{{ env.PASSWORD }}"
      into: the Password field
  - click: the Sign in button
  - checkElementVisible: the account menu
`;

export const EXAMPLE_KNOWLEDGE = `# Project knowledge for Memento's agents. Reviewed and versioned like code.
- type: terminology
  term: workspace switcher
  definition: The dropdown in the top-left corner showing the current workspace name.
- type: rule
  title: Prefer the main navigation
  agent: act
  instruction: Navigate using the left sidebar rather than typing URLs, unless the goal gives a URL.
- type: flow
  intent: create a project
  steps:
    - Click "New project" in the sidebar
    - Enter a name and press Create
  successState: The new project's dashboard opens with its name in the header.
`;
