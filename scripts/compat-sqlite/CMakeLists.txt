cmake_minimum_required(VERSION 3.16)
project(sqlite3_shell C)

# Wrapper CMake for the SQLite amalgamation (libsqlite3-dev / sqlite-amalgamation-*.zip).
# Expects -DSQLITE_SRC_DIR=<dir containing sqlite3.c and shell.c>.
# POA dogfood lane: build a fully static sqlite3 shell for the Windows target.

if(NOT SQLITE_SRC_DIR)
  message(FATAL_ERROR "SQLITE_SRC_DIR not set — point it at the extracted sqlite-amalgamation directory")
endif()

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_library(sqlite3_static STATIC "${SQLITE_SRC_DIR}/sqlite3.c")
target_compile_definitions(sqlite3_static PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_MAX_MMAP_SIZE=0
)
if(NOT WIN32)
  target_compile_definitions(sqlite3_static PRIVATE SQLITE_ENABLE_FTS4=1 SQLITE_ENABLE_FTS5=1)
endif()

add_executable(sqlite3 "${SQLITE_SRC_DIR}/shell.c")
target_link_libraries(sqlite3 PRIVATE sqlite3_static)
if(UNIX AND NOT APPLE)
  target_link_libraries(sqlite3 PRIVATE dl m pthread)
endif()
