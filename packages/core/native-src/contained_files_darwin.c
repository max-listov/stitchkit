#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value fail(napi_env env, const char *operation) {
  char message[512];
  snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static bool integer_argument(napi_env env, napi_value value, int *result) {
  int32_t parsed;
  if (napi_get_value_int32(env, value, &parsed) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected an integer file descriptor");
    return false;
  }
  *result = parsed;
  return true;
}

static bool entry_argument(napi_env env, napi_value value, char **result) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a relative entry name");
    return false;
  }
  char *name = malloc(length + 1);
  if (name == NULL) {
    napi_throw_error(env, NULL, "Unable to allocate entry name");
    return false;
  }
  if (napi_get_value_string_utf8(env, value, name, length + 1, &length) != napi_ok) {
    free(name);
    napi_throw_type_error(env, NULL, "Expected a relative entry name");
    return false;
  }
  if (length == 0 || strcmp(name, ".") == 0 || strcmp(name, "..") == 0 ||
      strchr(name, '/') != NULL) {
    free(name);
    napi_throw_range_error(env, NULL, "Descriptor-relative entry names must be one safe segment");
    return false;
  }
  *result = name;
  return true;
}

static bool two_arguments(napi_env env, napi_callback_info info, napi_value values[2]) {
  size_t count = 2;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 2) {
    napi_throw_type_error(env, NULL, "Expected two arguments");
    return false;
  }
  return true;
}

static napi_value open_at(napi_env env, napi_callback_info info, int flags) {
  napi_value values[2];
  if (!two_arguments(env, info, values)) return NULL;
  int directory;
  char *name = NULL;
  if (!integer_argument(env, values[0], &directory) || !entry_argument(env, values[1], &name)) {
    return NULL;
  }
  int descriptor = openat(directory, name, flags | O_NOFOLLOW | O_CLOEXEC);
  int saved = errno;
  free(name);
  if (descriptor < 0) {
    errno = saved;
    return fail(env, "openat");
  }
  napi_value result;
  napi_create_int32(env, descriptor, &result);
  return result;
}

static napi_value open_directory_at(napi_env env, napi_callback_info info) {
  return open_at(env, info, O_RDONLY | O_DIRECTORY);
}

static napi_value open_file_at(napi_env env, napi_callback_info info) {
  return open_at(env, info, O_RDONLY);
}

static napi_value create_file_at(napi_env env, napi_callback_info info) {
  napi_value values[3];
  size_t count = 3;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 3) {
    napi_throw_type_error(env, NULL, "Expected directory, entry name and mode");
    return NULL;
  }
  int directory;
  int32_t mode;
  char *name = NULL;
  if (!integer_argument(env, values[0], &directory) || !entry_argument(env, values[1], &name) ||
      napi_get_value_int32(env, values[2], &mode) != napi_ok) {
    free(name);
    napi_throw_type_error(env, NULL, "Expected an integer mode");
    return NULL;
  }
  int descriptor = openat(directory, name,
                          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                          (mode_t)mode);
  int saved = errno;
  free(name);
  if (descriptor < 0) {
    errno = saved;
    return fail(env, "openat create");
  }
  napi_value result;
  napi_create_int32(env, descriptor, &result);
  return result;
}

static napi_value stat_object(napi_env env, const struct stat *metadata) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value mode;
  napi_create_uint32(env, (uint32_t)metadata->st_mode, &mode);
  napi_set_named_property(env, result, "mode", mode);
  napi_value size;
  napi_create_double(env, (double)metadata->st_size, &size);
  napi_set_named_property(env, result, "size", size);
  return result;
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!two_arguments(env, info, values)) return NULL;
  int directory;
  char *name;
  if (!integer_argument(env, values[0], &directory) || !entry_argument(env, values[1], &name)) {
    return NULL;
  }
  struct stat metadata;
  int status = fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW);
  int saved = errno;
  free(name);
  if (status < 0) {
    errno = saved;
    if (errno == ENOENT) {
      napi_value result;
      napi_get_null(env, &result);
      return result;
    }
    return fail(env, "fstatat");
  }
  return stat_object(env, &metadata);
}

static napi_value list_at(napi_env env, napi_callback_info info) {
  napi_value values[1];
  size_t count = 1;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 1) {
    napi_throw_type_error(env, NULL, "Expected one directory descriptor");
    return NULL;
  }
  int directory;
  if (!integer_argument(env, values[0], &directory)) return NULL;
  int duplicate = dup(directory);
  if (duplicate < 0) return fail(env, "dup");
  DIR *stream = fdopendir(duplicate);
  if (stream == NULL) {
    close(duplicate);
    return fail(env, "fdopendir");
  }
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat metadata;
    if (fstatat(directory, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      int saved = errno;
      closedir(stream);
      errno = saved;
      return fail(env, "fstatat directory entry");
    }
    napi_value item = stat_object(env, &metadata);
    napi_value name;
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_named_property(env, item, "name", name);
    napi_set_element(env, result, index++, item);
  }
  int saved = errno;
  closedir(stream);
  if (saved != 0) {
    errno = saved;
    return fail(env, "readdir");
  }
  return result;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value values[3];
  size_t count = 3;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != 3) {
    napi_throw_type_error(env, NULL, "Expected directory and two entry names");
    return NULL;
  }
  int directory;
  char *source = NULL;
  char *target = NULL;
  if (!integer_argument(env, values[0], &directory) ||
      !entry_argument(env, values[1], &source) || !entry_argument(env, values[2], &target)) {
    free(source);
    free(target);
    return NULL;
  }
  int status = renameat(directory, source, directory, target);
  int saved = errno;
  free(source);
  free(target);
  if (status < 0) {
    errno = saved;
    return fail(env, "renameat");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!two_arguments(env, info, values)) return NULL;
  int directory;
  char *name;
  if (!integer_argument(env, values[0], &directory) || !entry_argument(env, values[1], &name)) {
    return NULL;
  }
  int status = unlinkat(directory, name, 0);
  int saved = errno;
  free(name);
  if (status < 0 && saved != ENOENT) {
    errno = saved;
    return fail(env, "unlinkat");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
      {"openDirectoryAt", NULL, open_directory_at, NULL, NULL, NULL, napi_default, NULL},
      {"openFileAt", NULL, open_file_at, NULL, NULL, NULL, napi_default, NULL},
      {"createFileAt", NULL, create_file_at, NULL, NULL, NULL, napi_default, NULL},
      {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
      {"listAt", NULL, list_at, NULL, NULL, NULL, napi_default, NULL},
      {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
      {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

NAPI_MODULE(contained_files_darwin, initialize)
