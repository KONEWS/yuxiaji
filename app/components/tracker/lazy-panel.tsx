"use client";

import { Component, Suspense, type ReactNode } from "react";
import { useDialogBehavior } from "./use-dialog-behavior";

function PanelNotice({ failed = false, close }: { failed?: boolean; close: () => void }) {
  const { dialogRef } = useDialogBehavior({ close });
  return <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} tabIndex={-1} className="modal-card panel-notice" role="dialog" aria-modal="true" aria-label={failed ? "窗口加载失败" : "正在打开窗口"}>
      <p role={failed ? "alert" : "status"}>{failed ? "窗口加载失败，请检查网络后刷新页面重试。" : "正在打开…"}</p>
      <button className="quiet-button" onClick={close}>关闭</button>
    </section>
  </div>;
}

export class LazyPanel extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <PanelNotice failed close={this.props.close} />;
    return <Suspense fallback={<PanelNotice close={this.props.close} />}>{this.props.children}</Suspense>;
  }
}
