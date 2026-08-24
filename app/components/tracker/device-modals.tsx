"use client";

import { useRef, useState } from "react";
import { uploadDeviceAsset } from "../../lib/client-api";
import { DEVICE_STATUSES, type DeviceCategoryDefinition, type DeviceCategoryId, type DeviceCategoryLabels, type DeviceSubCategoryMap } from "../../lib/constants";
import type { Device, DeviceForm } from "../../lib/tracker-types";
import { RoundedSelect } from "./common";

function DeviceModal({ form, setForm, device, categories, subCategories, close, submit }: { form: DeviceForm; setForm: (form: DeviceForm) => void; device: Device | null; categories: DeviceCategoryDefinition[]; subCategories: DeviceSubCategoryMap; close: () => void; submit: () => void }) {
  const receiptInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<"receipt" | "cover" | null>(null);
  const upload = async (file: File | undefined, purpose: "receipt" | "cover") => {
    if (!file) return;
    setUploading(purpose);
    try {
      const payload = await uploadDeviceAsset(file, purpose);
      setForm({ ...form, [purpose === "receipt" ? "receiptImage" : "coverImage"]: payload.url });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "图片上传失败，可改用图片地址");
    } finally {
      setUploading(null);
    }
  };
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card device-modal" role="dialog" aria-modal="true" aria-labelledby="device-title">
    <div className="modal-title"><div><p>装备库</p><h2 id="device-title">{device ? "编辑设备" : "添加设备"}</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <div className="form-grid">
      <label className="wide">设备名称<input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：雷鸟 GT Max" /></label>
      <label>大类<RoundedSelect value={form.category} onChange={(category) => setForm({ ...form, category, subCategory: subCategories[category]?.includes(form.subCategory) ? form.subCategory : "" })} options={categories.map((item) => ({ value: item.id, label: item.label }))} ariaLabel="设备大类" /></label>
      <label>子类<RoundedSelect value={form.subCategory} onChange={(subCategory) => setForm({ ...form, subCategory })} options={[{ value: "", label: "未分类" }, ...(subCategories[form.category] || []).map((sub) => ({ value: sub, label: sub }))]} ariaLabel="设备子类" /></label>
      <label>状态<RoundedSelect value={form.status} onChange={(status) => setForm({ ...form, status })} options={DEVICE_STATUSES.map((item) => ({ value: item.id, label: item.label }))} ariaLabel="设备状态" /></label>
      <label>入手价（CNY）<input type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="0.00" /></label>
      <label>入手日期<input type="date" value={form.purchaseDate} onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })} /></label>
      <label>评分（1-10）<RoundedSelect value={form.rating} onChange={(rating) => setForm({ ...form, rating })} options={[{ value: "", label: "未评分" }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 分` }))]} ariaLabel="设备评分" /></label>
      <label className="wide">特性标签<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="用逗号分隔，例如：平头塞，LDAC，3DoF" /></label>
      <label className="wide">封面图片<input type="url" value={form.coverImage} onChange={(event) => setForm({ ...form, coverImage: event.target.value })} placeholder="图片地址，或从本地上传" /><input ref={coverInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" style={{ display: "none" }} onChange={(event) => void upload(event.target.files?.[0], "cover")} /><button type="button" className="upload-button" onClick={() => coverInput.current?.click()} disabled={uploading === "cover"}>{uploading === "cover" ? "上传中…" : "上传封面"}</button>{form.coverImage && <span className="cover-preview"><img src={form.coverImage} alt="封面预览" referrerPolicy="no-referrer" /><b>已选择封面</b></span>}</label>
      <label className="wide">购买凭证截图<input type="url" value={form.receiptImage} onChange={(event) => setForm({ ...form, receiptImage: event.target.value })} placeholder="订单截图地址，或从本地上传" /><input ref={receiptInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" style={{ display: "none" }} onChange={(event) => void upload(event.target.files?.[0], "receipt")} /><button type="button" className="upload-button" onClick={() => receiptInput.current?.click()} disabled={uploading === "receipt"}>{uploading === "receipt" ? "上传中…" : "上传凭证"}</button>{form.receiptImage && <span className="cover-preview"><img src={form.receiptImage} alt="凭证预览" referrerPolicy="no-referrer" /><b>已上传凭证</b></span>}</label>
      <label className="wide">评价<textarea value={form.review} onChange={(event) => setForm({ ...form, review: event.target.value })} placeholder="使用感受、购入理由…" /></label>
    </div>
    <div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={submit}>{device ? "保存修改" : "加入装备库"}</button></div>
  </section></div>;
}

function DeviceSubCategoryModal({ value, categoryLabels, initialCategory, close, save, toast }: { value: DeviceSubCategoryMap; categoryLabels: DeviceCategoryLabels; initialCategory: DeviceCategoryId; close: () => void; save: (value: DeviceSubCategoryMap, labels: DeviceCategoryLabels) => void; toast: (value: string) => void }) {
  const [draft, setDraft] = useState<DeviceSubCategoryMap>(() => Object.fromEntries(Object.entries(value).map(([key, names]) => [key, [...names]])) as DeviceSubCategoryMap);
  const [draftLabels, setDraftLabels] = useState<DeviceCategoryLabels>(() => ({ ...categoryLabels }));
  const [activeCategory, setActiveCategory] = useState<DeviceCategoryId>(initialCategory);
  const [name, setName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const add = () => {
    const next = name.trim();
    if (!next) return;
    if (draft[activeCategory].includes(next)) { toast("这个子类已经存在"); return; }
    setDraft((current) => ({ ...current, [activeCategory]: [...current[activeCategory], next] }));
    setName("");
  };
  const addCategory = () => {
    const label = categoryName.trim().slice(0, 30);
    if (!label) return;
    if (Object.values(draftLabels).some((item) => item === label)) { toast("这个大类已经存在"); return; }
    const id = `custom_${Date.now().toString(36)}`;
    setDraftLabels((current) => ({ ...current, [id]: label }));
    setDraft((current) => ({ ...current, [id]: [] }));
    setActiveCategory(id);
    setCategoryName("");
    setAddingCategory(false);
  };
  const removeCategory = () => {
    const ids = Object.entries(draftLabels).filter(([, label]) => label.trim()).map(([id]) => id);
    if (ids.length <= 1) { toast("至少保留一个设备大类"); return; }
    const nextId = ids.find((id) => id !== activeCategory) || ids[0];
    setDraftLabels((current) => ({ ...current, [activeCategory]: "" }));
    setDraft((current) => { const next = { ...current }; delete next[activeCategory]; return next; });
    setActiveCategory(nextId);
    setCategoryName("");
    setAddingCategory(false);
  };
  const move = (targetIndex: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    setDraft((current) => {
      const names = [...current[activeCategory]];
      const [moved] = names.splice(from, 1);
      names.splice(targetIndex, 0, moved);
      return { ...current, [activeCategory]: names };
    });
  };
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card subcategory-modal" role="dialog" aria-modal="true" aria-labelledby="subcategory-title">
    <div className="modal-title"><div><p>装备库</p><h2 id="subcategory-title">管理设备分类</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <nav className="subcategory-tabs" aria-label="选择设备大类">{Object.entries(draftLabels).filter(([, label]) => label.trim()).map(([id, label]) => <button key={id} className={activeCategory === id ? "active" : ""} onClick={() => setActiveCategory(id)}>{label}</button>)}{addingCategory ? <span className="category-add-inline"><input id="device-category-name" autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addCategory(); if (event.key === "Escape") { setCategoryName(""); setAddingCategory(false); } }} maxLength={30} placeholder="大类名称" aria-label="新设备大类名称" /><button type="button" onClick={addCategory} aria-label="确认添加设备大类" title="确认">✔</button></span> : <button type="button" className="category-add-tab" onClick={() => setAddingCategory(true)} aria-label="添加设备大类">＋</button>}</nav>
    <div className="category-name-editor"><label>当前大类名称<input value={draftLabels[activeCategory] || ""} onChange={(event) => setDraftLabels((labels) => ({ ...labels, [activeCategory]: event.target.value }))} maxLength={30} /></label><button type="button" className="manager-delete-button category-delete-button" onClick={removeCategory} aria-label="删除当前设备大类" title="删除当前大类">×</button></div>
    <div className="subcategory-sort-list">{(draft[activeCategory] || []).length ? (draft[activeCategory] || []).map((subCategory, index) => <div key={subCategory} draggable onDragStart={() => { dragIndex.current = index; }} onDragEnd={() => { dragIndex.current = null; }} onDragOver={(event) => event.preventDefault()} onDrop={() => move(index)}><span aria-hidden="true">☰</span><b>{subCategory}</b><small>拖动排序</small><button type="button" className="manager-delete-button" onClick={() => setDraft((current) => ({ ...current, [activeCategory]: (current[activeCategory] || []).filter((item) => item !== subCategory) }))} aria-label={`删除子类${subCategory}`} title="删除子类">×</button></div>) : <p className="manager-empty">当前大类还没有子类</p>}</div>
    <div className="subcategory-add"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} placeholder="新子类名称" /><button onClick={add}>＋ 添加</button></div>
    <div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={() => save(draft, draftLabels)}>保存修改</button></div>
  </section></div>;
}

function ReceiptModal({ device, close }: { device: Device; close: () => void }) {
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
    <div className="modal-title"><div><p>购买凭证</p><h2 id="receipt-title">{device.name}</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <img className="receipt-image" src={device.receiptImage} alt={`${device.name}购买凭证`} referrerPolicy="no-referrer" />
    <p className="receipt-meta">{device.price != null ? `入手价 ¥${device.price.toLocaleString("zh-CN")}` : "入手价未记录"}{device.purchaseDate ? ` · ${device.purchaseDate} 入手` : ""}{device.tags.length ? ` · ${device.tags.join(" / ")}` : ""}</p>
  </section></div>;
}

export { DeviceModal, DeviceSubCategoryModal, ReceiptModal };
