#!/bin/bash

[[ -n "${_PERSISTENT_DATA_MIGRATE_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_MIGRATE_SH_LOADED=1

# Migration engine for persistent-data volumes: Docker access helpers plus the
# shared and project migration flows. Sourced explicitly by bin/devcontainer-data
# (an entrypoint), not by loader.sh - see the note in loader.sh for why.

# cli_require_docker: Verifies that migration can reach the Docker daemon.
cli_require_docker() {
	if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
		log_error 'Migration requires Docker CLI and daemon access'
		return 1
	fi
}

# cli_confirm_migration: Requires an explicit interactive migration confirmation.
cli_confirm_migration() {
	local reply

	if [[ ! -t 0 ]]; then
		log_error 'Migration requires an interactive confirmation'
		return 1
	fi
	log_warning 'Close any agents or editors writing to the source or workspace volumes before continuing.'
	log_warning 'This migration changes destination data. Type yes to continue:'
	read -r reply </dev/tty
	if [[ "$reply" != 'yes' ]]; then
		log_error 'Migration cancelled'
		return 1
	fi
}

# cli_docker_volume_names: Prints available named Docker volumes.
cli_docker_volume_names() {
	docker volume ls --format '{{.Name}}'
}

# cli_docker_volume_exists: Checks whether a named volume exists.
cli_docker_volume_exists() {
	docker volume inspect "$1" >/dev/null 2>&1
}

# cli_docker_container_id: Prints the running legacy container ID.
cli_docker_container_id() {
	local hostname_path="${PERSISTENT_DATA_HOSTNAME_PATH:-/etc/hostname}"

	if [[ -n "${PERSISTENT_DATA_CONTAINER_ID:-}" ]]; then
		printf '%s\n' "$PERSISTENT_DATA_CONTAINER_ID"
		return 0
	fi
	if [[ ! -r "$hostname_path" ]]; then
		log_error 'Migration cannot identify the current container'
		return 1
	fi
	cat "$hostname_path"
}

# cli_docker_helper: Runs a verified copy or layout operation in the current image.
# Args: helper script, Docker run arguments following the image.
cli_docker_helper() {
	local helper_script="$1" container_id image
	shift

	container_id=$(cli_docker_container_id) || return 1
	image=$(docker inspect "$container_id" --format '{{.Config.Image}}') || {
		log_error 'Migration cannot determine the current container image'
		return 1
	}
	docker run --rm --entrypoint bash "$@" "$image" -ceu "$helper_script"
}

# cli_volume_schema_state: Prints empty, valid, invalid, or data for a volume scope.
cli_volume_schema_state() {
	local volume="$1" scope="$2"

	case "$scope" in shared|project) ;; *) return 1 ;; esac
	cli_docker_helper '
source /opt/devcontainer/setup/lib/loader.sh
persistent_data_schema_state "$SCOPE"
' -e 'PERSISTENT_DATA_SHARED_ROOT=/destination' -e 'PERSISTENT_DATA_PROJECT_ROOT=/destination' \
		-e "SCOPE=$scope" -v "$volume:/destination"
}

# cli_shared_categories: Prints only registry categories in the shared scope.
cli_shared_categories() {
	local category_id category scope
	while IFS= read -r category_id; do
		category=$(persistent_data_category "$category_id") || return 1
		scope=$(jq -r '.scope' <<<"$category")
		[[ "$scope" == 'shared' ]] && printf '%s\n' "$category_id"
	done < <(persistent_data_category_ids)
}

# cli_migrate_shared: Collects selections and migrates the shared volume under its lock.
cli_migrate_shared() {
	local destination_volume='devcontainer-shared-data' state category_id category_path source
	local -a sources=() categories=() helper_args=() destinations=()

	cli_require_docker || return 1
	if cli_docker_volume_exists "$destination_volume"; then
		state=$(cli_volume_schema_state "$destination_volume" shared) || return 1
		if [[ "$state" == 'valid' ]]; then
			log_success 'Shared persistent-data migration is already complete'
			return 0
		fi
		if [[ "$state" != 'empty' ]]; then
			log_error 'Shared migration destination has incomplete or unknown data'
			return 1
		fi
	fi

	log_info 'Available source volumes:'
	cli_docker_volume_names | while IFS= read -r source; do log_detail "$source"; done
	while IFS= read -r category_id; do
		log_info "Select source volume for $category_id, or type skip:"
		read -r source </dev/tty
		if [[ "$source" == 'skip' ]]; then
			continue
		fi
		if [[ "$source" == "$destination_volume" ]]; then
			log_error 'Shared migration destination cannot be a source volume'
			return 1
		fi
		if ! cli_docker_volume_exists "$source"; then
			log_error "Unknown Docker volume: $source"
			return 1
		fi
		if [[ " ${sources[*]} " == *" $source "* ]]; then
			log_error "Docker volume is already selected: $source"
			return 1
		fi
		sources+=("$source")
		categories+=("$category_id")
	done < <(cli_shared_categories)

	log_warning 'Skipped categories cannot be migrated later.'
	for category_id in "${!categories[@]}"; do
		category_path=$(persistent_data_category_path "${categories[$category_id]}") || return 1
		log_detail "${sources[$category_id]} -> ${categories[$category_id]} -> $category_path"
	done
	cli_confirm_migration || return 1
	cli_docker_volume_exists "$destination_volume" || docker volume create "$destination_volume" >/dev/null || return 1
	helper_args=(-e 'PERSISTENT_DATA_SHARED_ROOT=/var/lib/devcontainer' -v "$destination_volume:/var/lib/devcontainer")
	for category_id in "${!categories[@]}"; do
		category_path=$(persistent_data_category_path "${categories[$category_id]}") || return 1
		destinations+=("${category_path#"$(persistent_data_root shared)/"}")
		helper_args+=(-v "${sources[$category_id]}:/source-$category_id:ro")
	done
	cli_docker_helper '
source /opt/devcontainer/setup/lib/loader.sh
migrate_shared_locked() {
  state=$(persistent_data_schema_state shared) || return 1
  if [[ "$state" == valid ]]; then
    log_success "Shared persistent-data migration is already complete"
    return 0
  fi
  if [[ "$state" != empty ]]; then
    log_error "Shared migration destination has incomplete or unknown data"
    return 1
  fi
  if [[ "$MIGRATION_SELECTION_COUNT" -gt 0 ]]; then
    readarray -t destinations <<<"$MIGRATION_DESTINATIONS"
    for index in "${!destinations[@]}"; do
      persistent_data_copy_verified "/source-$index" "/var/lib/devcontainer/${destinations[$index]}" || return 1
    done
  fi
  persistent_data_schema_mark_migrated shared
}
with_shared_data_lock migrate_shared_locked
' -e "MIGRATION_SELECTION_COUNT=${#destinations[@]}" -e "MIGRATION_DESTINATIONS=$(printf '%s\n' "${destinations[@]}")" "${helper_args[@]}" || {
		log_error 'Shared migration copy failed; source volumes were preserved'
		return 1
	}
	log_success 'Shared persistent-data migration completed; source volumes were preserved'
}

# cli_project_mounts: Prints current named mounts below /workspace as name|destination.
cli_project_mounts() {
	local container_id mount volume destination
	container_id=$(cli_docker_container_id) || return 1
	while IFS= read -r mount; do
		volume=${mount%%|*}
		destination=${mount#*|}
		[[ "$destination" == '/workspace' || "$destination" == '/workspace/'* ]] && printf '%s|%s\n' "$volume" "$destination"
	done < <(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}{{println}}{{end}}{{end}}')
}

# cli_project_is_compose: Returns success only for a Compose-managed container.
cli_project_is_compose() {
	local container_id label
	container_id=$(cli_docker_container_id) || return 1
	label=$(docker inspect "$container_id" --format '{{index .Config.Labels "com.docker.compose.project"}}') || return 1
	[[ -n "$label" && "$label" != '<no value>' ]]
}

# cli_migrate_project_dockerfile: Backs up and reorganizes one legacy workspace volume.
cli_migrate_project_dockerfile() {
	local project_name="$1" backup_volume state
	local source_volume="$project_name-data"
	backup_volume="$source_volume-backup-${PERSISTENT_DATA_MIGRATION_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"
	if ! cli_docker_volume_exists "$source_volume"; then
		log_error "Legacy project volume does not exist: $source_volume"
		return 1
	fi
	state=$(cli_volume_schema_state "$source_volume" project) || return 1
	if [[ "$state" == 'valid' ]]; then
		log_success 'Project persistent-data migration is already complete'
		return 0
	fi
	if [[ "$state" == 'invalid' ]]; then
		log_error 'Project migration destination has an unsupported schema marker'
		return 1
	fi
	if cli_docker_volume_exists "$backup_volume"; then
		log_error "Project migration backup already exists: $backup_volume"
		return 1
	fi
	cli_confirm_migration || return 1
	docker volume create "$backup_volume" >/dev/null || return 1
	cli_docker_helper '
source /opt/devcontainer/setup/lib/loader.sh
migrate_project_locked() {
  state=$(persistent_data_schema_state project) || return 1
  if [[ "$state" == valid ]]; then
    log_success "Project persistent-data migration is already complete"
    return 0
  fi
  if [[ "$state" == invalid ]]; then
    log_error "Project migration destination has an unsupported schema marker"
    return 1
  fi
  persistent_data_copy_verified /workspace /backup || return 1
  persistent_data_copy_verified /backup "/workspace/$PROJECT_NAME" || return 1
  find /workspace -mindepth 1 -maxdepth 1 ! -name .persistent-data.lock ! -name "$PROJECT_NAME" -exec rm -rf -- {} + || return 1
  persistent_data_schema_mark_migrated project
}
with_project_data_lock migrate_project_locked
' -e 'PERSISTENT_DATA_PROJECT_ROOT=/workspace' -e "PROJECT_NAME=$project_name" \
		-v "$source_volume:/workspace" -v "$backup_volume:/backup" || {
			log_error 'Project migration copy failed; preserve the backup volume for recovery'
			return 1
		}
	log_warning 'Project data migrated. Regenerate configuration and rebuild or reopen the container; keep the backup volume until verified.'
}

# cli_migrate_project_compose: Copies effective Compose workspace mounts into an explicit volume.
cli_migrate_project_compose() {
	local project_name="$1" state mount volume destination relative root_volume=''
	local destination_volume="$project_name-data"
	local -a mounts=() destinations=() helper_args=() sorted_mounts=() sorted_destinations=()

	if cli_docker_volume_exists "$destination_volume"; then
		state=$(cli_volume_schema_state "$destination_volume" project) || return 1
		if [[ "$state" == 'valid' ]]; then
			log_success 'Project persistent-data migration is already complete'
			return 0
		fi
		if [[ "$state" != 'empty' ]]; then
			log_error 'Project migration destination has incomplete or unknown data'
			return 1
		fi
	fi
	while IFS= read -r mount; do
		volume=${mount%%|*}
		destination=${mount#*|}
		relative=${destination#/workspace}
		for destination in "${destinations[@]}"; do
			if [[ -n "$relative" && -n "$destination" && ( "$relative" == "$destination" || "$relative" == "$destination"/* || "$destination" == "$relative"/* ) ]]; then
				log_error "Project migration mounts overlap: $mount"
				return 1
			fi
		done
		if [[ -z "$relative" ]]; then
			if [[ -n "$root_volume" ]]; then
				log_error "Project migration mounts overlap: $mount"
				return 1
			fi
			root_volume="$volume"
		else
			mounts+=("$volume")
			destinations+=("$relative")
		fi
	done < <(cli_project_mounts)
	if [[ -z "$root_volume" && "${#mounts[@]}" -eq 0 ]]; then
		log_error 'No named workspace volumes are mounted below /workspace'
		return 1
	fi
	if [[ -n "$root_volume" ]]; then
		sorted_mounts+=("$root_volume")
		sorted_destinations+=('')
	fi
	while IFS=$'\t' read -r relative volume; do
		sorted_mounts+=("$volume")
		sorted_destinations+=("$relative")
	done < <(for mount in "${!mounts[@]}"; do printf '%s\t%s\n' "${destinations[$mount]}" "${mounts[$mount]}"; done | sort)
	cli_confirm_migration || return 1
	cli_docker_volume_exists "$destination_volume" || docker volume create "$destination_volume" >/dev/null || return 1
	helper_args=(-e 'PERSISTENT_DATA_PROJECT_ROOT=/workspace' -v "$destination_volume:/workspace")
	for mount in "${!sorted_mounts[@]}"; do
		helper_args+=(-v "${sorted_mounts[$mount]}:/source-$mount:ro")
	done
	cli_docker_helper '
source /opt/devcontainer/setup/lib/loader.sh
migrate_project_locked() {
  state=$(persistent_data_schema_state project) || return 1
  if [[ "$state" == valid ]]; then
    log_success "Project persistent-data migration is already complete"
    return 0
  fi
  if [[ "$state" != empty ]]; then
    log_error "Project migration destination has incomplete or unknown data"
    return 1
  fi
  readarray -t destinations <<<"$MIGRATION_DESTINATIONS"
  for index in "${!destinations[@]}"; do
    persistent_data_copy_verified "/source-$index" "/workspace/${destinations[$index]}" || return 1
  done
  persistent_data_schema_mark_migrated project
}
with_project_data_lock migrate_project_locked
' -e "MIGRATION_DESTINATIONS=$(printf '%s\n' "${sorted_destinations[@]}")" "${helper_args[@]}" || {
		log_error 'Project migration copy failed; legacy source volumes were preserved'
		return 1
	}
	log_warning 'Project data migrated. Regenerate configuration and rebuild or reopen the container; preserve legacy volumes until verified.'
}

# cli_migrate_project: Runs the project migration under the project-data lock.
cli_migrate_project() {
	local project_name

	project_name="${PROJECT_NAME:-}"
	if [[ -z "$project_name" ]]; then
		project_name=$(basename "$PWD") || return 1
	fi
	cli_require_docker || return 1
	cd / || return 1
	if cli_project_is_compose; then cli_migrate_project_compose "$project_name"; else cli_migrate_project_dockerfile "$project_name"; fi
}

export -f cli_require_docker cli_confirm_migration cli_docker_volume_names \
	cli_docker_volume_exists cli_docker_container_id cli_docker_helper \
	cli_volume_schema_state cli_shared_categories cli_migrate_shared \
	cli_project_mounts cli_project_is_compose cli_migrate_project_dockerfile \
	cli_migrate_project_compose cli_migrate_project
