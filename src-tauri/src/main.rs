use mindseb_lib::MindIpcRouter;

fn main() {
    println!("mindseb-backend v0.1.0 starting (Tauri v2 desktop memory graph)...");
    let router = MindIpcRouter::new();
    if let Ok(state) = router.dispatch("mind:get_state", "") {
        println!("Initial state: {state}");
    }
}
