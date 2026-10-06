//! macOS：父进程退出即结束本进程。
//!
//! 宿主被强制终止时 worker 不得残留。Windows 由宿主的作业对象承担，Linux 由宿主在启动 worker 时
//! 设置的 `PR_SET_PDEATHSIG` 承担；macOS 没有这两种机制，由 worker 自身使用 kqueue 的
//! `EVFILT_PROC` 等待父进程的 `NOTE_EXIT`。
//!
//! stdin 结束即退出（`serve::run`）不能替代本机制：stdin 只在管道的写端全部关闭时结束，写端被
//! 宿主启动的其他子进程继承时，宿主退出之后 stdin 不会结束。

use std::io::{Error, ErrorKind};
use std::ptr;

/// 登记对父进程退出的监听，再启动一条线程等待该事件。父进程在登记之前已退出时立即结束本进程。
///
/// 登记失败只写入 stderr，不阻止启动：此时退出仍由 stdin 结束承担。
pub fn exit_with_parent() {
    // SAFETY: 无参数。
    let parent = unsafe { libc::getppid() };
    // 父进程已经退出时本进程由 launchd（pid 1）收养。
    if parent <= 1 {
        std::process::exit(0);
    }
    // SAFETY: 无参数；失败返回 -1。
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        eprintln!(
            "创建 kqueue 失败，父进程退出时本进程不会随之退出：{}",
            Error::last_os_error()
        );
        return;
    }
    let change = libc::kevent {
        ident: parent as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: ptr::null_mut(),
    };
    // SAFETY: 变更表指向局部变量、长度为 1；不取事件，不设超时。
    if unsafe { libc::kevent(queue, &change, 1, ptr::null_mut(), 0, ptr::null()) } < 0 {
        let error = Error::last_os_error();
        // `getppid` 与登记之间父进程已经退出。
        if error.raw_os_error() == Some(libc::ESRCH) {
            std::process::exit(0);
        }
        eprintln!("登记父进程退出监听失败，父进程退出时本进程不会随之退出：{error}");
        return;
    }
    std::thread::spawn(move || loop {
        let mut event = std::mem::MaybeUninit::<libc::kevent>::zeroed();
        // SAFETY: 事件表指向局部变量、长度为 1；不带变更，不设超时。
        let n = unsafe { libc::kevent(queue, ptr::null(), 0, event.as_mut_ptr(), 1, ptr::null()) };
        if n > 0 {
            std::process::exit(0);
        }
        if n < 0 && Error::last_os_error().kind() != ErrorKind::Interrupted {
            eprintln!("等待父进程退出失败：{}", Error::last_os_error());
            return;
        }
    });
}
