## Docker: build, run, and push

Quick instructions for building and running the FizzSwap relayer from Docker.

Build a local image (fast, skip contract/web builds):

```bash
docker build -t youruser/fizzdex:latest \
  --build-arg SKIP_COMPILE=true \
  --build-arg SKIP_WEB_BUILD=true .
```

Run the relayer container (recommended: use an env file or pass envs at runtime):

```bash
# Using an env file
docker run --rm -p 4001:4001 --env-file .env \
  -v $(pwd)/relayer-mappings.json:/app/relayer-mappings.json \
  youruser/fizzdex:latest

# Or passing specific envs
docker run --rm -p 4001:4001 \
  -e RELAYER_PORT=4001 \
  -e EVM_RPC=http://host.docker.internal:8545 \
  -e RELAYER_PRIVATE_KEY='0x...' \
  youruser/fizzdex:latest
```

Build and run with docker compose (development via Ganache):

```bash
docker compose up --build
```

Push to Docker Hub:

```bash
docker login
docker tag youruser/fizzdex:latest youruser/fizzdex:1.0.0
docker push youruser/fizzdex:1.0.0
```

Push to GitHub Container Registry (GHCR):

```bash
echo "$CR_PAT" | docker login ghcr.io -u YOUR_GH_USER --password-stdin
docker tag youruser/fizzdex:latest ghcr.io/YOUR_GH_USER/fizzdex:1.0.0
docker push ghcr.io/YOUR_GH_USER/fizzdex:1.0.0
```

Security notes
- Never bake secrets into images. Use `--env-file`, `-e`, or a secrets manager.
- Keep `relayer-mappings.json` private (it's persisted to disk by the relayer).

If you'd like, I can add a GitHub Action to build and publish this image on push.
