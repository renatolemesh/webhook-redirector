# Meta Webhook Forwarder

This is a simple, self-hosted API built with **Express** and **TypeScript** that acts as a central hub for Meta's WhatsApp webhooks. It solves the problem of Meta only allowing a single webhook URL by receiving the event and forwarding it to multiple configured endpoints (e.g., Evolution, Chatwoot).

It includes a simple web interface for managing the target webhooks and viewing the log of received events.

## Features

*   **Webhook Receiver:** Handles Meta's webhook verification (`GET /webhook`) and event reception (`POST /webhook`).
*   **Multi-Target Forwarding:** Asynchronously queues the received payload for forwarding to all active, configured webhooks.
*   **Persistent Retry Mechanism:** Implements a robust retry schedule for failed forwarding attempts (3 immediate retries, then retries after 10m, 30m, 1h, and 6h) using a persistent job queue, ensuring no events are lost on server restart.
*   **PostgreSQL Database:** Uses a PostgreSQL database to store configured webhooks and a log of received events. The new job queue also tracks the status and retry count for each forwarding attempt.
*   **Simple Web Interface:** A basic HTML/JavaScript interface to add, edit, activate/deactivate, and delete target webhooks, and view the recent log.
*   **Dockerized:** Ready to run on any server using `docker-compose`.

## Prerequisites

*   [Docker](https://www.docker.com/get-started)
*   [Docker Compose](https://docs.docker.com/compose/install/)

## Setup and Run

1.  **Clone the repository (or download the source code):**
    \`\`\`bash
    git clone <repository-url>
    cd meta-webhook-forwarder
    \`\`\`

2.  **Configure Environment Variables:**
    Copy the example environment file and update the values.

    \`\`\`bash
    cp .env .env.local
    # Now edit .env.local
    \`\`\`

    **Important Variables in `.env.local`:**

    | Variable | Description |
    | :--- | :--- |
    | `VERIFY_TOKEN` | **MUST** be a secret string of your choice. You will use this token when setting up the webhook in the Meta App Dashboard. |
    | `DB_PASSWORD` | Change this to a strong, secret password for your PostgreSQL database. |

3.  **Build and Run with Docker Compose:**
    This command will build the API image, start the API container, and start the PostgreSQL database container.

    \`\`\`bash
    docker-compose up --build -d
    \`\`\`

    The API will be running on port `3000` (or the port you configured).

## Usage

1.  **Configure Meta Webhook:**
    *   In your Meta App Dashboard, set the **Webhook URL** to `http://your-server-ip:3000/webhook`.
    *   Set the **Verify Token** to the value you set in your `.env.local` file (`VERIFY_TOKEN`).
    *   Subscribe to the necessary fields (e.g., `messages`).

2.  **Configure Target Webhooks (Evolution, Chatwoot, etc.):**
    *   Open the configuration interface in your browser: `http://your-server-ip:3000/`
    *   Use the interface to add the target webhook URLs for **Evolution** and **Chatwoot**.
    *   Give them descriptive names (e.g., "Evolution API", "Chatwoot Webhook").
    *   Ensure they are marked as **Active**.

3.  **Monitor:**
    *   The "Job Queue Status" section on the configuration page shows the number of jobs currently pending, processing, successful, or failed.
*   The "Recent Received Webhooks" section shows a log of all events received from Meta. The detailed forwarding status is now managed by the job queue.

## Development

If you want to run the application without Docker (for development):

1.  **Install Dependencies:**
    \`\`\`bash
    npm install
    \`\`\`
2.  **Start PostgreSQL:**
    You will need a local PostgreSQL instance running. Update the `DB_*` variables in `.env.local` to point to your local database.
3.  **Run the API:**
    \`\`\`bash
    npm run start:dev # You might need to add a start:dev script for ts-node-dev
    # For now, you can use:
    npx ts-node src/server.ts
    \`\`\`

## Project Structure

\`\`\`
.
├── Dockerfile
├── docker-compose.yml
├── .env
├── .gitignore
├── package.json
├── public
│   └── index.html  # Simple configuration interface
├── src
    ├── db.ts               # PostgreSQL connection and initialization
    ├── forwarderService.ts # Logic to create jobs for forwarding
    ├── jobQueueModel.ts    # Database models for the persistent job queue
    ├── jobWorker.ts        # Background worker implementing the retry logic
    ├── server.ts           # Main Express application
    ├── tsconfig.json
    ├── webhookConfigRouter.ts # API routes for configuration
    └── webhookModel.ts     # Database models for configured webhooks and received logs
\`\`\`
