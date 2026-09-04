PNPM := pnpm
DOCKER_IMAGE := tapoo-oracle
DOCKER_VOLUME := tapoo-node-modules
.DEFAULT_GOAL := help

.PHONY: help install audit agentic-analysis typecheck lint test coverage quality ci dev build serve deploy clean observable docker-build docker-run docker-shell

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the reviewed, locked dependencies.
	CI=true $(PNPM) install --frozen-lockfile --config.confirmModulesPurge=false

audit: ## Fail if the lockfile has known vulnerabilities.
	osv-scanner --lockfile=pnpm-lock.yaml

agentic-analysis: ## Answer the rubric for exported Tapoo logs; usage: make agentic-analysis LOGS="a.json b.json"
	@test -n "$(LOGS)" || \
		( echo 'Set LOGS to one or more exported logs, e.g. make agentic-analysis LOGS="a.json b.json"' >&2; exit 1 )
	node ./scripts/agentic-analysis.mjs $(LOGS)

typecheck: ## Type-check the app and the tooling. Nothing is emitted.
	CI=true $(PNPM) --config.confirmModulesPurge=false run typecheck

lint: ## Run eslint over the app and tooling sources.
	CI=true $(PNPM) --config.confirmModulesPurge=false run lint

test: ## Run the test suite.
	CI=true $(PNPM) --config.confirmModulesPurge=false run test

coverage: ## Run the test suite with coverage.
	CI=true $(PNPM) --config.confirmModulesPurge=false run coverage

quality: ## Run the type check, lint and tests.
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test

ci: ## Run the local equivalent of the CI pipeline.
	$(MAKE) install
	$(MAKE) audit
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) build

dev: ## Bundle the app and start the local preview server, rebuilding as sources change.
	$(PNPM) dev

build: ## Bundle the app, build the static site into ./public, then clean up.
	$(PNPM) build

serve: ## Serve ./public the way a static host does, with HTML caching off.
	$(PNPM) run serve

deploy: ## Deploy the app to Observable.
	$(PNPM) deploy

clean: ## Clear the local data loader cache.
	$(PNPM) clean

observable: ## Run Observable CLI commands; pass ARGS="help" for example.
	$(PNPM) observable $(ARGS)

docker-build: ## Build development image.
	docker build -t $(DOCKER_IMAGE) .

docker-run: ## Run project in Colima/Docker.
	docker run --rm -it \
		-p 3000:3000 \
		$(DOCKER_IMAGE)

docker-shell: ## Open a shell inside the development container.
	docker run --rm -it \
		-v "$(PWD):/workspace" \
		-v $(DOCKER_VOLUME):/workspace/node_modules \
		$(DOCKER_IMAGE) \
		bash