# Deploy on a free Oracle Cloud VM

lucid-rag self-hosts as a Docker Compose stack, so it runs on any Docker host.
The **Oracle Cloud Free Tier** is a good always-free target: the Ampere ARM
"Always Free" shape gives up to **4 OCPU / 24 GB RAM** at no cost, which
comfortably runs the app + Postgres/pgvector (and even a local Ollama). All the
images used are multi-arch, so they run natively on ARM.

> Estimated time: ~15 minutes. You need an Oracle Cloud account (free) and an SSH key.

## 1. Create the VM

- Oracle Cloud console → **Compute → Instances → Create instance**.
- **Image:** Ubuntu 22.04 (or 24.04). **Shape:** `VM.Standard.A1.Flex` (Ampere ARM,
  Always Free) — e.g. **2 OCPU / 12 GB** is plenty.
- Add your **SSH public key**.
- Note the assigned **public IP**.

## 2. Open the app port

Two layers block ports on Oracle by default — open both, or the app is unreachable:

1. **VCN security list (cloud firewall):** VCN → your subnet's security list → add an
   **ingress rule**: source `0.0.0.0/0`, TCP, destination port **3000**. (Port 22 is
   already open.)
2. **OS firewall (the Oracle gotcha):** Ubuntu images ship with an iptables rule that
   drops everything except 22. SSH in and open 3000:
   ```bash
   sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT
   sudo netfilter-persistent save   # persist across reboots
   ```

> For a real deployment, restrict the source to your IP, or put lucid-rag behind a
> reverse proxy (Caddy/Traefik) that terminates HTTPS on 443 and only expose that.

## 3. Install Docker

```bash
ssh ubuntu@<public-ip>
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker   # run docker without sudo
```

## 4. Clone, configure, run

```bash
git clone https://github.com/shivajithmutteal/lucid-rag
cd lucid-rag
cp .env.example .env
# Edit .env: add ONE provider key (e.g. GROQ_API_KEY — free tier), or leave empty
# for local Ollama (see below). Do NOT set DATABASE_URL — compose points it at db.
docker compose up --build -d      # builds the app + starts Postgres; runs detached
docker compose logs -f app        # watch startup
```

Open **http://\<public-ip\>:3000**. Upload a document, ask a question, inspect the
trace. The schema is created automatically on first request.

## 5. (Optional) Fully local — no API keys

Uncomment the `ollama` service (and its volume) in `docker-compose.yml`, set
`OLLAMA_HOST=http://ollama:11434` in `.env`, then:

```bash
docker compose up --build -d
docker compose exec ollama ollama pull llama3.2 nomic-embed-text
```

Now generation + embeddings run locally on the VM — no keys, no data leaving it.
(A 12 GB shape handles small models; scale the ARM shape up for larger ones.)

## Operating

- **Persistence:** documents/vectors live in the `lucid_pgdata` Docker volume;
  `docker compose down` keeps it, `docker compose down -v` wipes it.
- **Updates:** `git pull && docker compose up --build -d`.
- **Auto-restart:** the `app` service uses `restart: unless-stopped`, so it comes
  back after a reboot (Docker starts on boot on Ubuntu).
- **Locked-down public instance:** set `LUCID_READONLY=true` in `.env` to disable
  uploads (queries + the trace viewer stay available).

## Cost

Zero, if you stay within the Always Free Ampere allowance. Keep the account active
(Oracle reclaims idle Always Free resources after long inactivity).
