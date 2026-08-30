PNPM ?= pnpm

.DEFAULT_GOAL := help

.PHONY: help install audit agentic-analysis lint test coverage quality ci dev build deploy clean observable

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the reviewed, locked dependencies.
	CI=true $(PNPM) install --frozen-lockfile --config.confirmModulesPurge=false

audit: ## Fail if the lockfile has known vulnerabilities.
	$(PNPM) audit --audit-level=low

agentic-analysis: ## Answer the rubric for exported Tapoo logs; usage: make agentic-analysis LOGS="a.json b.json"
	@test -n "$(LOGS)" || \
		( echo 'Set LOGS to one or more exported logs, e.g. make agentic-analysis LOGS="a.json b.json"' >&2; exit 1 )
	node ./scripts/agentic-analysis.mjs $(LOGS)

lint: ## Run eslint over the app and tooling sources.
	CI=true $(PNPM) --config.confirmModulesPurge=false run lint

test: ## Run the test suite.
	CI=true $(PNPM) --config.confirmModulesPurge=false run test

coverage: ## Run the test suite with coverage.
	CI=true $(PNPM) --config.confirmModulesPurge=false run coverage

quality: ## Run lint and tests.
	$(MAKE) lint
	$(MAKE) test

ci: ## Run the local equivalent of the CI pipeline.
	$(MAKE) install
	$(MAKE) audit
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) build

dev: ## Start the local preview server.
	$(PNPM) dev

build: ## Build the static site into ./dist.
	$(PNPM) build

deploy: ## Deploy the app to Observable.
	$(PNPM) deploy

clean: ## Clear the local data loader cache.
	$(PNPM) clean

observable: ## Run Observable CLI commands; pass ARGS="help" for example.
	$(PNPM) observable $(ARGS)
