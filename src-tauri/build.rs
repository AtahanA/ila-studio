// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Atahan Aggunlu

fn main() {
    // The report address of a release comes from the environment of its build (src/crash_reports.rs reads it
    // with option_env!): a build that follows another must notice when it is set, changed or taken away.
    println!("cargo:rerun-if-env-changed=ILA_SENTRY_DSN");
    tauri_build::build()
}
