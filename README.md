# Estravon — self-hosted backend

Extract nominated sections of a book PDF as Markdown and attach them directly
to the Zotero item — synced, versioned, always co-located with the source.

The extracted `.md` files include full provenance metadata (pages, backend,
extraction date, schema version) and content statistics (word counts, vocabulary
profile). They can be read in Zotero, searched, and fed into downstream tools.

---

## Two ways to use Estravon

**Hosted (no setup):** visit [estravon.com](https://estravon.com), buy a credit pack,
paste one API key into the plugin preferences, and start extracting. Nothing to install
or maintain on your machine.

**Self-hosted (this repo):** run the backend on your own machine with your own Mistral
API key. AGPL-3.0. Full control, no ongoing cost beyond your Mistral usage.

---

## Prerequisites (self-hosted)

- **Zotero 7.0** or newer
- **Python 3.10+**
- An API key for one of the supported extraction backends:

| Backend | Pricing | Notes |
|---|---|---|
| [Mistral](https://console.mistral.ai/) | Pay-as-you-go | Default. No subscription needed. |
| [Datalab](https://www.datalab.to/) | $25/month flat | Single-user subscription. Slightly higher throughput at peak. |
| [Replicate](https://replicate.com/) | Pay-as-you-go | Runs the same Datalab model but without concurrency; lower idle cost. |

Set `_ZM_BACKEND=mistral` (default), `_ZM_BACKEND=datalab`, or `_ZM_BACKEND=replicate`
in your `.env` file to choose.

---

## Installation

### 1 — Install the Zotero plugin

Download `estravon-<version>.xpi` from the
[latest GitHub Release](../../releases/latest).

In Zotero: **Tools → Plugins → Install Add-on From File…** → select the `.xpi`.

After the initial install the plugin auto-updates via Zotero's built-in update
mechanism — no manual action needed for future releases.

On first launch the plugin opens `estravon.com/start` in your browser; follow the
"Make it yourself" path to set up the self-hosted backend.

### 2 — Install and start the Python backend

```bash
pip install estravon-backend
```

Copy the example environment file and add your API key:

```bash
cp .env.example .env
# Edit .env: set MISTRAL_API_KEY (or DATALAB_API_KEY / REPLICATE_API_TOKEN)
# Optionally set _ZM_BACKEND=datalab or _ZM_BACKEND=replicate to switch backends
```

Start the backend:

```bash
estravon --port 7766
```

Keep this terminal running while you use the plugin. In Zotero → Settings → Estravon,
confirm the status indicator is green.

---

## First extraction

1. Open Zotero and right-click a **Book** item that has a PDF attachment.
2. Select **Extract Section to Markdown…**
3. Fill in the section name (e.g. `chapter_1`), page range (e.g. `1-40`),
   and extraction mode (`balanced` is a good default).
4. Click **Extract** and wait. The backend calls the Mistral OCR API and returns
   when done (typically 30–90 seconds for 40 pages).
5. The extracted `.md` file and any images appear as child attachments on the
   Zotero item. An **Extraction log** child note records the provenance.

---

## Configuration

Plugin preferences are in **Zotero → Settings → Estravon**:

| Preference | Default | Description |
|---|---|---|
| Backend URL | `http://localhost:7766` | Self-hosted backend address |
| Default chunk size | `80` | Pages per API call (reduce for large scanned books) |
| Default mode | `balanced` | `fast` / `balanced` / `accurate` |

---

## Checking backend health

```bash
curl http://localhost:7766/ping
# {"status":"ok","state":"idle","backend":"mistral"}

curl http://localhost:7766/status
# {"state":"idle","state_since_s":12.3,"backend":"mistral","last_job":{}}
```

The `/status` endpoint shows the current server state (idle / running / error) and
the details of the last job — useful for debugging without SSH access.

---

## Roadmap

**v0.4.x (now):** Self-hosted vanilla backend + Zotero plugin. Uses Mistral OCR.

**v0.5.x:** Plugin session telemetry (`/jobs/{id}/ack`); per-chunk quality scores.

**Post-launch:** LLM agent that extracts all chapters from a book autonomously
(requires the tools server — separate repository, not yet public).

---

## Issues and feedback

Please report bugs and feature requests via
[GitHub Issues](../../issues).

Feedback on extraction quality for scanned books, non-English texts, or books with
heavy mathematical notation is especially welcome.

---

## License

[AGPL-3.0](LICENSE) — the same license as Zotero itself.
