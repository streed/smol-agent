# Cross-Agent Communication Protocol

This document describes how smol-agent instances communicate across repositories
using the inbox/letter protocol.

## Overview

Agents communicate by dropping markdown "letters" into each other's `.smol-agent/inbox/`
directories. A watcher process detects new letters, spawns an agent to handle them,
and ensures a response is always delivered back to the caller.

## Flow Diagram

```mermaid
sequenceDiagram
    participant A as Agent A<br/>(frontend repo)
    participant AR as Agent Registry<br/>(~/.config/smol-agent/agents.json)
    participant BI as Agent B Inbox<br/>(.smol-agent/inbox/)
    participant B as Agent B<br/>(backend repo)
    participant AI as Agent A Inbox<br/>(.smol-agent/inbox/)

    Note over A: 1. Discovery
    A->>AR: find_agent_for_task("need REST endpoint")
    AR-->>A: Best match: "backend-api" (score: 0.8)

    Note over A: 2. Send Letter
    A->>BI: send_letter(to: "backend-api", title, body)
    A->>A: Save copy in outbox for tracking

    Note over B: 3. Detect & Process
    BI-->>B: fs.watch() detects new .letter.md
    B->>B: Mark letter "in-progress"
    B->>B: Spawn smol-agent with letter prompt

    Note over B: 4. Do the Work
    B->>B: Read files, edit code, run tests
    B->>B: git commit changes

    Note over B: 5. Send Reply
    B->>BI: reply_to_letter(changes_made, api_contract)
    B->>AI: Deliver response to Agent A's inbox

    Note over A: 6. Receive Notification
    AI-->>A: watchForResponses() detects .response.md
    A->>A: Inject reply into conversation
    A->>A: Emit "cross_agent_reply" event
    Note over A: Agent A continues with<br/>response data (no polling needed)
```

## Auto-Reply Safety Net

If the spawned agent exits without calling `reply_to_letter`, the system
auto-generates a response:

```mermaid
flowchart TD
    A[Agent B exits] --> B{Response file<br/>exists?}
    B -->|Yes| C[Deliver to sender's inbox]
    B -->|No| D{Exit code = 0?}
    D -->|Yes| E[Auto-generate 'completed' response]
    D -->|No| F[Auto-generate 'failed' response<br/>with stderr excerpt]
    E --> C
    F --> C
```

## Directory Layout

```
repo-a/                              repo-b/
  .smol-agent/                         .smol-agent/
    inbox/                               inbox/
      <uuid>.letter.md    <-- sent -->     <uuid>.letter.md
      <uuid>.response.md  <-- recv <--    <uuid>.response.md
    outbox/                              outbox/
      <uuid>.letter.md (tracking copy)
```

## Letter Format

### Request (`.letter.md`)

```markdown
---
id: 550e8400-e29b-41d4-a716-446655440000
type: request
title: Add user avatar field to GET /users
from: /home/user/frontend
to: /home/user/backend-api
in_reply_to:
status: pending
priority: medium
created_at: 2026-03-09T12:00:00.000Z
---

# Add user avatar field to GET /users

## Body

The frontend needs an `avatar_url` field in the GET /users response...

## Acceptance Criteria

- GET /users returns avatar_url field
- Field is nullable (not all users have avatars)

## Context

Frontend component: src/components/UserList.tsx
```

### Response (`.response.md`)

```markdown
---
id: 660e8400-e29b-41d4-a716-446655440001
type: response
title: Add user avatar field to GET /users
from: /home/user/backend-api
to: /home/user/frontend
in_reply_to: 550e8400-e29b-41d4-a716-446655440000
status: completed
priority: normal
created_at: 2026-03-09T12:05:00.000Z
---

# Re: Add user avatar field to GET /users

## Changes Made

Added `avatar_url` (nullable string) to the User model and GET /users response.

## API Contract / Interface

GET /users now returns: `{ id, name, email, avatar_url: string | null }`

## Notes

Migration required: `npm run db:migrate`
```

## Notification Modes

| Mode | How it works | When to use |
|------|-------------|-------------|
| **Auto-notification** | `watchForResponses()` injects reply into conversation | Default - agent is notified automatically |
| **Blocking wait** | `send_letter(wait_for_reply: true)` blocks until reply | When you need the result before continuing |
| **Manual poll** | `check_reply(letter_id)` checks for response | Re-reading a specific reply |

## Architecture Components

```mermaid
graph LR
    subgraph "Agent A Process"
        A1[Agent.run] --> A2[send_letter tool]
        A3[watchForResponses] --> A4[_pendingInjections]
        A4 --> A1
    end

    subgraph "File System"
        I1[Agent B .smol-agent/inbox/]
        I2[Agent A .smol-agent/inbox/]
    end

    subgraph "Agent B Process"
        B1[watchInbox] --> B2[processLetter]
        B2 --> B3[Spawned Agent]
        B3 --> B4[reply_to_letter tool]
        B2 --> B5[autoReplyIfMissing]
    end

    subgraph "Global"
        R[Agent Registry<br/>agents.json]
    end

    A2 -->|write .letter.md| I1
    I1 -->|fs.watch| B1
    B4 -->|write .response.md| I2
    B5 -.->|fallback write| I2
    I2 -->|fs.watch| A3
    A2 -.->|lookup| R
```
