set positional-arguments

# Repo root. Resolves correctly when run from this repo, or when imported from the ~/.pi/justfile wrapper.
REPO := justfile_directory()

[default]
_list-recipes:
    just --list

# Run the permission-mode generator check, the just-tools tests, the provider rules check, the feature-ledger check and tests, and the skill script tests. Prints one line per group at the end: name, pass count, fail count. The full output is still written to the log file. Exit is non-zero when any group fails.
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

    run_group "perm check" just -f "${justfile}" perm check
    run_group "just-tools test" just -f "${justfile}" just-tools test
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

# Generate, check, or test the permission-mode config from ~/.pi/agent/permission-mode/permission-mode.src.jsonc. Actions: gen, check, or test. Use --force with gen to overwrite a drifted output. Pass-through flags go after `--` (for example `just perm test -- --only merge`).
[arg('action', pattern='gen|check|test', help='gen, check, or test')]
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
        test)
            node --test "${gen_dir}"/*.test.ts ${extra[@]+"${extra[@]}"}
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
