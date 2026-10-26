"use client";

import { lazy } from "react";

export const DeviceModal = lazy(() => import("./device-modals").then((module) => ({ default: module.DeviceModal })));
export const DeviceSubCategoryModal = lazy(() => import("./device-modals").then((module) => ({ default: module.DeviceSubCategoryModal })));
export const ReceiptModal = lazy(() => import("./device-modals").then((module) => ({ default: module.ReceiptModal })));
export const AddModal = lazy(() => import("./media-modals").then((module) => ({ default: module.AddModal })));
export const CalendarModal = lazy(() => import("./media-modals").then((module) => ({ default: module.CalendarModal })));
export const CollectionManagerModal = lazy(() => import("./media-modals").then((module) => ({ default: module.CollectionManagerModal })));
export const CollectionModal = lazy(() => import("./media-modals").then((module) => ({ default: module.CollectionModal })));
export const CompletionModal = lazy(() => import("./media-modals").then((module) => ({ default: module.CompletionModal })));
export const DetailDrawer = lazy(() => import("./media-modals").then((module) => ({ default: module.DetailDrawer })));
export const VideoSubtypeModal = lazy(() => import("./media-modals").then((module) => ({ default: module.VideoSubtypeModal })));
export const VisualSubtypeModal = lazy(() => import("./media-modals").then((module) => ({ default: module.VisualSubtypeModal })));
export const ConnectivityModal = lazy(() => import("./integration-modals").then((module) => ({ default: module.ConnectivityModal })));
export const SettingsModal = lazy(() => import("./integration-modals").then((module) => ({ default: module.SettingsModal })));
export const SyncMenu = lazy(() => import("./integration-modals").then((module) => ({ default: module.SyncMenu })));
export const SyncModal = lazy(() => import("./integration-modals").then((module) => ({ default: module.SyncModal })));
export const TagManagerModal = lazy(() => import("./media-modals").then((module) => ({ default: module.TagManagerModal })));
