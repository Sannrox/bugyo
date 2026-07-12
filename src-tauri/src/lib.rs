//! kiro-app (Bugyo) backend library.
//!
//! Tauri command handlers live in [`commands`] and [`service`] and stay thin;
//! the feature modules ([`acp`], [`workspace`], [`orchestrator`], [`state`])
//! hold the testable logic.

pub mod acp;
mod commands;
pub mod config;
pub mod orchestrator;
pub mod screenshot;
mod service;
pub mod state;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    // Auto-update + restart-after-install are desktop-only (no mobile updater).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(service::AcpManager::default())
        .setup(|app| {
            // Share the manager with a background heartbeat task.
            let manager = app.state::<service::AcpManager>().inner().clone();
            manager.register_app(app.handle().clone());
            // Load persisted sessions (cold) so the fleet survives restarts.
            tauri::async_runtime::block_on(manager.hydrate());
            service::spawn_heartbeat(manager.clone());
            service::spawn_automation_scheduler(manager.clone());
            service::spawn_trigger_scheduler(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            service::acp_start_session,
            service::acp_cancel,
            service::acp_respond_permission,
            service::acp_prompt_with_screenshot,
            service::acp_list_sessions,
            service::acp_close_session,
            service::acp_delete_session,
            service::workspace_create,
            service::workspace_archive,
            service::workspace_diff,
            service::workspace_review_state,
            service::workspace_check,
            service::workspace_commit,
            service::workspace_merge,
            service::workspace_merge_preview,
            service::workspace_open_pr,
            service::orch_enqueue,
            service::orch_queue,
            service::orch_queue_replace,
            service::orch_preview,
            service::orch_heartbeat_secs,
            service::orch_log,
            service::project_list,
            service::project_add,
            service::project_update,
            service::project_remove,
            service::session_transcript,
            service::session_meta_list,
            service::session_meta_set,
            service::session_search,
            service::budget_get,
            service::budget_set,
            service::set_attention_badge,
            service::trust_profile_list,
            service::trust_profile_set,
            service::trust_profile_remove,
            service::trust_profile_effective_tools,
            service::automation_list,
            service::automation_create,
            service::automation_update,
            service::automation_remove,
            service::automation_run_now,
            service::trigger_list,
            service::trigger_create,
            service::trigger_update,
            service::trigger_remove,
            service::trigger_run_now,
        ])
        // SAFETY: failing to start the app is unrecoverable; crash loudly.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
