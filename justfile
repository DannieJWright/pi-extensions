set positional-arguments

# Repo root. Resolves correctly when run from this repo, or when imported from the ~/.pi/justfile wrapper.
REPO := justfile_directory()

[default]
_list-recipes:
    just --list

# Run the permission-mode generator check, the just-tools tests, and the provider prompt rules check.
[group('test')]
test:
    just -f "{{ REPO }}/justfile" perm check
    just -f "{{ REPO }}/justfile" just-tools test
    just -f "{{ REPO }}/justfile" provider-rules check

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

# Generate, check, or test the permission-mode config from permission-mode.src.jsonc. Actions: gen, check, or test. Use --force with gen to overwrite a drifted output. Pass-through flags go after `--` (for example `just perm test -- --only merge`).
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

# Check or test the provider prompt rules config. Actions: check, or test. Pass Node options after `--` (for example `just provider-rules test -- --test-name-pattern=resolve`).
[arg('action', pattern='check|test', help='check, or test')]
[group('test')]
provider-rules action="check" *args="":
    #!/usr/bin/env bash
    set -euo pipefail

    ext_dir="{{ REPO }}/extensions/provider-prompt-rules"
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
