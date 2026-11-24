set positional-arguments

# Repo root. Resolves correctly when run from this repo, or when imported from the ~/.pi/justfile wrapper.
REPO := justfile_directory()

[default]
_list-recipes:
    just --list

# Run the permission-mode generator tests, the sample fixture comparison, subagent config, just-tools and git-tools tests, provider rules check, feature-ledger check and tests, and skill tests. Prints one line per group; exits non-zero on failure.
[group('test')]
test:
    #!/usr/bin/env bash
    set -euo pipefail

    justfile="{{ REPO }}/justfile"
    summary=()
    overall=0

    run_group() {
        name="$1"
        shift

        status=0
        out="$("$@" 2>&1)" || status=$?

        # Keep the full output on stdout so the log file holds it as before.
        printf '%s\n' "$out"

        # The counts come from the Node test runner's summary lines, "ℹ pass" and "ℹ fail". If that
        # format changes, no line matches and the group falls back to one result by exit status, the
        # same way a check group is counted here.
        pass=""
        fail=""
        if line=$(printf '%s\n' "$out" | grep '^ℹ pass ' | head -1); then pass=${line#ℹ pass }; fi
        if line=$(printf '%s\n' "$out" | grep '^ℹ fail ' | head -1); then fail=${line#ℹ fail }; fi
        # A check group has no test counts: one run is one result.
        if [ -z "${pass}" ] && [ -z "${fail}" ]; then
            pass=0
            fail=0
            if [ "${status}" -eq 0 ]; then pass=1; else fail=1; fi
        fi

        if [ "${status}" -ne 0 ]; then overall=1; fi
        summary+=("${name} pass=${pass} fail=${fail}")
    }

    gen_dir="{{ REPO }}/extensions/permission-mode-generator"
    # Generator tests author their own fixtures in temporary directories, so a failure there cannot come from a changed
    # configuration file. The sample comparison reads this repository's example configuration and its committed fixture,
    # so it is reported as a separate group. Running `just perm test` directly still runs every *.test.ts here at once.
    run_group "perm generator test" node --test "${gen_dir}/generate.test.ts" "${gen_dir}/json-roundtrip.test.ts" "${gen_dir}/merge.test.ts" "${gen_dir}/migrate.test.ts" "{{ REPO }}/lib/settings-lock.test.ts"
    run_group "perm sample test" node --test "${gen_dir}/sample-integration.test.ts"
    run_group "subagent config test" node --test "{{ REPO }}/extensions/permission-mode-generator/config.test.ts"
    run_group "just-tools test" just -f "${justfile}" just-tools test
    run_group "git-tools test" just -f "${justfile}" git-tools test
    run_group "provider-rules check" just -f "${justfile}" provider-rules check
    run_group "feature-ledger check" just -f "${justfile}" feature-ledger check
    run_group "feature-ledger test" just -f "${justfile}" feature-ledger test
    run_group "skills test" just -f "${justfile}" skills test

    echo
    echo "summary:"
    for line in ${summary[@]+"${summary[@]}"}; do echo "${line}"; done

    exit "${overall}"

# Run the just-tools and permission-mode merge tests. Pass Node options after `--` (for example `just just-tools test -- --test-name-pattern=grep`).
[arg('action', pattern='test', help='test')]
[group('test')]
just-tools action="test" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    action="$1"
    shift; # Shift for `action`
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        test)
            node --test "{{ REPO }}/extensions/just-tools/just-tools.test.ts" "{{ REPO }}/extensions/just-tools/execution.test.ts" "{{ REPO }}/extensions/permission-mode-generator/merge.test.ts" ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac

# Run the Git inspection tool tests. Pass Node options after `--` (for example `just git-tools test -- --test-name-pattern=diff`).
[arg('action', pattern='test', help='test')]
[group('test')]
git-tools action="test" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    action="$1"
    shift; # Shift for `action`
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        test)
            node --test "{{ REPO }}/extensions/git-tools/git-tools.test.ts" "{{ REPO }}/extensions/git-tools/runtime.integration.test.ts" ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac

# Generate/check permissionModes and optional subagents outputs from ~/.pi/agent/permissions.src.jsonc; $file paths are source-relative. Migrate imports the old source and settings. Use --force with gen to overwrite drift; pass-through flags go after `--`.
[arg('action', pattern='gen|check|migrate|test', help='gen, check, migrate, or test')]
[arg('force', long='force', value='true', help='Specify --force with gen to overwrite a drifted output')]
[group('perm')]
perm action="gen" force="false" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    gen_dir="{{ REPO }}/extensions/permission-mode-generator"
    action="$1"
    force="$2"
    shift; # Shift for `action`
    shift; # Shift for `force`

    # `just` passes an empty default for *args, so drop empty entries before forwarding them.
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        gen)
            force_flag=""
            if [ "${force}" = "true" ]; then force_flag="--force"; fi
            node "${gen_dir}/generate.ts" gen ${force_flag} ${extra[@]+"${extra[@]}"}
            ;;
        check)
            node "${gen_dir}/generate.ts" check ${extra[@]+"${extra[@]}"}
            ;;
        migrate)
            node "${gen_dir}/generate.ts" migrate ${extra[@]+"${extra[@]}"}
            ;;
        test)
            node --test "${gen_dir}"/*.test.ts "{{ REPO }}/lib/settings-lock.test.ts" ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac

# Check or test the provider rules config (prompt rules and truncation recovery). Actions: check, or test. Pass Node options after `--` (for example `just provider-rules test -- --test-name-pattern=resolve`).
[arg('action', pattern='check|test', help='check, or test')]
[group('test')]
provider-rules action="check" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    ext_dir="{{ REPO }}/extensions/provider-rules"
    action="$1"
    shift; # Shift for `action`

    # `just` passes an empty default for *args, so drop empty entries before forwarding them.
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        check)
            node "${ext_dir}/check.ts" ${extra[@]+"${extra[@]}"}
            ;;
        test)
            node --test "${ext_dir}"/*.test.ts ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac

# Check or test the feature-ledger extension. Actions: check, or test. Check defaults to the reference ledger and accepts a real-ledger path. Pass Node options after `--` (for example `just feature-ledger test -- --test-name-pattern=round-trip`).
[arg('action', pattern='check|test', help='check, or test')]
[group('test')]
feature-ledger action="check" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    ext_dir="{{ REPO }}/extensions/feature-ledger"
    action="$1"
    shift; # Shift for `action`

    # `just` passes an empty default for *args, so drop empty entries before forwarding them.
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        check)
            node "${ext_dir}/check.ts" ${extra[@]+"${extra[@]}"}
            ;;
        test)
            node --test "${ext_dir}"/*.test.ts ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac

# Run the skill script tests. Actions: test. Use --skill <name> to limit the run to one skill. Pass Node options after `--` (for example `just skills test -- --test-name-pattern=flow`).
[arg('action', pattern='test', help='test')]
[arg('skill', long='skill', value='', help='Specify --skill <name> to limit the run to one skill')]
[group('test')]
skills action="test" skill="" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    action="$1"
    skill="$2"
    shift; # Shift for `action`
    shift; # Shift for `skill`

    # `just` passes an empty default for *args, so drop empty entries before forwarding them.
    extra=()
    for arg in "$@"; do
        if [ -n "${arg}" ]; then extra+=("${arg}"); fi
    done

    case "${action}" in
        test)
            files=()
            for f in $(find "{{ REPO }}/skills${skill:+/${skill}}" -name '*.test.mjs'); do files+=("${f}"); done
            if [ ${#files[@]} -eq 0 ]; then
                echo "no skill test files found${skill:+ in skills/${skill}}" >&2
                exit 1
            fi
            node --test ${files[@]+"${files[@]}"} ${extra[@]+"${extra[@]}"}
            ;;
        *)
            echo "unknown action: ${action}" >&2
            exit 2
            ;;
    esac
