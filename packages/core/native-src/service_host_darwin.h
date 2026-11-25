/*
 * macOS service-host N-API primitives included by contained_files_darwin.c:
 * - renameSwapAt: atomic directory exchange via renameatx_np(..., RENAME_SWAP)
 * - responsiblePid: dynamic dlsym lookup for responsibility_get_pid_responsible_for_pid
 * - processPath: executable path lookup via proc_pidpath
 */
#include <dlfcn.h>

static napi_value rename_swap_at(napi_env env, napi_callback_info info) {
  napi_value values[4];
  size_t count = 4;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 4) {
    napi_throw_type_error(
        env, NULL, "Expected source directory, source name, target directory, and target name");
    return NULL;
  }
  int from_directory;
  int to_directory;
  char *from_name = NULL;
  char *to_name = NULL;
  if (!integer_argument(env, values[0], &from_directory) ||
      !entry_argument(env, values[1], &from_name) ||
      !integer_argument(env, values[2], &to_directory) ||
      !entry_argument(env, values[3], &to_name)) {
    free(from_name);
    free(to_name);
    return NULL;
  }
  int status = renameatx_np(from_directory, from_name, to_directory, to_name, RENAME_SWAP);
  int saved = errno;
  free(from_name);
  free(to_name);
  if (status < 0) {
    errno = saved;
    return fail(env, "renameatx_np");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static bool positive_pid_argument(napi_env env, napi_callback_info info, int32_t *result) {
  napi_value values[1];
  size_t count = 1;
  int32_t pid = 0;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_int32(env, values[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_type_error(env, NULL, "Expected a positive process ID");
    return false;
  }
  *result = pid;
  return true;
}

static napi_value responsible_pid(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!positive_pid_argument(env, info, &pid)) return NULL;
  void *symbol = dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  if (symbol == NULL) {
    errno = EOPNOTSUPP;
    return fail(env, "responsibility_get_pid_responsible_for_pid");
  }
  typedef pid_t (*responsibility_fn)(pid_t);
  responsibility_fn fn = NULL;
  memcpy(&fn, &symbol, sizeof(fn));
  errno = 0;
  pid_t responsible = fn((pid_t)pid);
  if (responsible <= 0) {
    /* No errno is no cause: the error carries no code rather than a guessed one. */
    if (errno == 0) {
      napi_throw_error(env, NULL,
                       "responsibility_get_pid_responsible_for_pid returned no process and no errno");
      return NULL;
    }
    return fail(env, "responsibility_get_pid_responsible_for_pid");
  }
  napi_value result;
  napi_create_int32(env, (int32_t)responsible, &result);
  return result;
}

static napi_value process_path(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!positive_pid_argument(env, info, &pid)) return NULL;
  char buffer[PROC_PIDPATHINFO_MAXSIZE];
  errno = 0;
  int length = proc_pidpath((int)pid, buffer, (uint32_t)sizeof(buffer));
  if (length <= 0 || (size_t)length > sizeof(buffer)) {
    /* No errno is no cause: the error carries no code rather than a guessed one. */
    if (errno == 0) {
      napi_throw_error(env, NULL, "proc_pidpath returned no path and no errno");
      return NULL;
    }
    return fail(env, "proc_pidpath");
  }
  napi_value result;
  napi_create_string_utf8(env, buffer, (size_t)length, &result);
  return result;
}
