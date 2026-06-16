"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 위험 동작(삭제 등)이면 확인 버튼을 destructive 스타일로. */
  destructive?: boolean;
}

/**
 * native confirm() 대체용 Promise 기반 확인 다이얼로그.
 *
 * 사용:
 *   const { confirm, confirmDialog } = useConfirm();
 *   async function handleDelete() {
 *     if (!(await confirm({ title: "삭제", description: "정말 삭제할까요?", destructive: true }))) return;
 *     ... // 실제 동작
 *   }
 *   return (<>{confirmDialog}{...버튼들}</>);
 *
 * confirmDialog를 컴포넌트 트리에 한 번 렌더링해야 동작한다.
 */
export function useConfirm() {
  const t = useTranslations("ui");
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({ title: "" });
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // If a confirm is already pending, settle it as false before replacing it -
    // otherwise the previous resolver is overwritten and its Promise hangs forever,
    // leaving that caller's `await confirm()` stuck.
    resolverRef.current?.(false);
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setOpen(false);
    resolverRef.current?.(value);
    resolverRef.current = null;
  }, []);

  const confirmDialog = (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // ESC/바깥 동작 등으로 닫히면 취소로 처리.
        if (!next) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts.title}</AlertDialogTitle>
          {opts.description != null && (
            <AlertDialogDescription>{opts.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {opts.cancelText ?? t("confirm.defaultCancel")}
          </AlertDialogCancel>
          <AlertDialogCancel
            variant={opts.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {opts.confirmText ?? t("confirm.defaultConfirm")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, confirmDialog };
}
