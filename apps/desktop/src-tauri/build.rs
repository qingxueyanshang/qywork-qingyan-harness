fn main() {
    // tauri_build 不为图标声明 rerun-if-changed。缺这一行时改 icons/ 不会触发构建脚本重跑，
    // exe 资源段里的仍是上次编译时嵌入的 icon.ico。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
