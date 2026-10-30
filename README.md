# @zyno-io/yarn-helper

Run the Yarn version declared by a project, with Corepack setup, private registry authentication and a bounded retry for Yarn's fetch cancellation crash.

```sh
npx --yes @zyno-io/yarn-helper@1 install --immutable
```

The helper installs Corepack when needed, enables persistent Yarn shims and respects `packageManager`, `devEngines.packageManager` and the project's `yarnPath`. It does not edit dependency declarations, lockfiles or project configuration. Normal lifecycle scripts, including `tsf-install`, still run.

If `.npmrc` routes the `@zyno-io` scope to a private registry, override that scope for the public bootstrap command:

```sh
npx --yes --@zyno-io:registry=https://registry.npmjs.org/ @zyno-io/yarn-helper@1 install --immutable
```

This override applies to npm's bootstrap request. Yarn keeps the dependency registries declared by the project.

Requires Node `^22.22.2`, `^24.15.0` or `>=26.0.0`, npm and a writable Node installation prefix. CI and Docker should normally use `node:26-alpine`; GitHub Actions should select `26.x` with `check-latest: true`.

## CI

```yaml
image: node:26-alpine

before_script:
  - npx --yes @zyno-io/yarn-helper@1 install --immutable

script:
  - yarn build
```

Keep any OS packages needed by your project, such as Git or native build libraries, in the job setup. The helper handles Node package-manager setup.

To enable Corepack and configure authentication before a later Yarn command, use:

```sh
npx --yes @zyno-io/yarn-helper@1 setup
yarn build
```

`setup` also works outside a Yarn project. It downloads the declared Yarn version when run inside one. A separate `--corepack-prefix` requires adding that prefix's `bin` directory to `PATH` for subsequent shell commands; on Windows add the prefix itself.

## Private registry authentication

When `PRIVATE_NPM_TOKEN` is present, the helper merges a registry-specific authentication entry for `https://npm.s24.dev/` into the user's `.yarnrc.yml`. The entry references the environment variable; it never contains the token value. Existing settings, registry mappings and comments are preserved. Public npm requests remain unauthenticated.

For a different registry or a Docker build secret:

```dockerfile
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN --mount=type=secret,id=npm_token \
    npx --yes @zyno-io/yarn-helper@1 \
      --npm-token-file /run/secrets/npm_token \
      install --immutable
COPY . .
RUN yarn build
```

Pass `--npm-registry https://registry.example/` before the Yarn command to select the token's registry. Registry selection for dependencies remains owned by the project's Yarn configuration. Mounted secrets are passed to the Yarn child through its environment and are not stored in the image's configuration.

## Command behavior

All arguments after the first Yarn command are forwarded literally, with the original working directory. With no command, the helper runs Yarn's default install. `--` passes the remaining arguments directly to Yarn, for example `yarn-helper -- --version`.

Only `install` and `workspaces focus` can be retried, and only for the exact uncaught `onCancel` exception from Yarn during fetching, before linking begins. At most two retries follow the first attempt. Checksum failures, authentication errors, lifecycle failures and ordinary build errors keep their original exit status. Interruptions stop the child and any pending retry.

Yarn 4.18.1 contains the upstream cancellation fix. The helper honors the project's declared version rather than upgrading Yarn implicitly.

| Helper option | Purpose |
| --- | --- |
| `--npm-token-file FILE` | Read a mounted private registry token |
| `--npm-registry URL` | Registry for that token; defaults to `https://npm.s24.dev/` |
| `--corepack-prefix PATH` | Use a writable Corepack installation prefix |
| `--force-corepack` | Allow npm to replace conflicting package-manager shims |
| `--help` | Show usage |
| `--version` | Show the helper version |

Options belong before the Yarn command. Existing Corepack installations are retained. On GitHub-hosted Windows runners, installing Corepack replaces the runner's conflicting Yarn 1 shims automatically.

## Development and publishing

```sh
npm ci
npm run check
npm test
npm run test:smoke
```

The integration test uses real Corepack and Yarn with isolated public/private fixture registries. It verifies authentication scope, persistent shims, immutable installs and lifecycle hooks. GitHub Actions runs tests on Linux, macOS and Windows, plus a packed CLI test on Node 26 Alpine.

Releases use the `publish-npm.yml` GitHub Actions workflow in `zyno-io/yarn-helper`. A version tag such as `v1.0.0` must match `package.json`. After all checks pass, the workflow publishes to public npm using OIDC trusted publishing and provenance, without an npm token stored in GitHub.

For the initial package only, npm requires an authenticated bootstrap publication before its trusted publisher can be configured. Configure `zyno-io/yarn-helper` and workflow filename `publish-npm.yml` with permission to publish directly. Subsequent version tags use the normal trusted publishing workflow.
