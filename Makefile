PNPM ?= pnpm
TAPOO ?= ../tapoo

.DEFAULT_GOAL := help

.PHONY: help install audit vendor check-vendor lint test coverage quality ci dev build deploy clean observable

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the reviewed, locked dependencies.
	CI=true $(PNPM) install --frozen-lockfile --config.confirmModulesPurge=false

audit: ## Fail if the lockfile has known vulnerabilities.
	$(PNPM) audit --audit-level=low

vendor: ## Re-copy Tapoo's analysis contract; pass TAPOO=path to use a local checkout.
	node ./scripts/vendor-analysis.mjs --from $(TAPOO)

check-vendor: ## Fail if the vendored Tapoo analysis contract is out of date.
	node ./scripts/check-vendor-drift.mjs

lint: ## Run eslint over the app and tooling sources.
	CI=true $(PNPM) --config.confirmModulesPurge=false run lint

test: ## Run the test suite.
	CI=true $(PNPM) --config.confirmModulesPurge=false run test

coverage: ## Run the test suite with coverage.
	CI=true $(PNPM) --config.confirmModulesPurge=false run coverage

quality: ## Run the offline vendor check, lint, and tests.
	node ./scripts/check-vendor-drift.mjs --offline
	$(MAKE) lint
	$(MAKE) test

ci: ## Run the local equivalent of the CI pipeline.
	$(MAKE) install
	$(MAKE) audit
	$(MAKE) check-vendor
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
