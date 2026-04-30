//! Filter macOS AppKit function-key text leaks at runtime.
//!
//! ## Why this exists
//!
//! On macOS Tauri/WKWebView, pressing left/right (and up/down) arrow keys
//! at a textarea boundary causes a Unicode private-use codepoint
//! (U+F700-F74F, AppKit's `NSFunctionKey` family) to be inserted into
//! the input value as a tofu glyph. The codepoint reaches the value via
//! AppKit's responder chain default — `NSResponder.keyDown:` →
//! `interpretKeyEvents:` → `insertText:` — bypassing WebCore's edit
//! pipeline entirely (no `beforeinput`, no `input` event), which means
//! a JS-side guard cannot catch it.
//!
//! Older wry versions fixed this by swallowing arrow `keyDown:` events
//! before AppKit could fall through to `insertText:`. Current WKWebView
//! versions still need that same `keyDown:` path for normal caret movement,
//! so swallowing arrows makes the cursor stop moving.
//!
//! Instead, install a narrow `insertText:` filter on wry's WKWebView
//! subclass. Arrow key events continue through WebKit unchanged; if AppKit
//! later tries to insert a pure NSFunctionKey private-use string, only that
//! insertion is dropped.
//!
//! That fix was lost during wry's objc2 migration and has NOT been
//! reintroduced in any released version up to wry 0.55.0 (2026-03-26).
//! Tracking: tauri-apps/wry#1175, tauri-apps/tauri#10194 — both OPEN.
//!
//! Since we have `tauri/unstable` enabled (needed for child webviews
//! used by the in-app browser), we hit the regression. Until upstream
//! relands a fix, we install our own `insertText:` IMPs at startup.

#![cfg(target_os = "macos")]

use std::sync::Once;

use objc2::ffi::{class_addMethod, class_getSuperclass, objc_msgSendSuper, objc_super};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};

static INSTALL: Once = Once::new();

pub fn install_arrow_key_filter() {
    INSTALL.call_once(|| unsafe {
        install_inner();
    });
}

unsafe fn install_inner() {
    let cls = match find_wry_webview_class() {
        Some(c) => c,
        None => {
            crate::ulog_warn!("[macos_arrow_filter] wry WKWebView subclass not found; arrow-key filter not installed (leak workaround inactive)");
            return;
        }
    };

    crate::ulog_info!(
        "[macos_arrow_filter] installing diagnostics on class chain: {}",
        class_chain(cls)
    );

    install_key_down_probe(cls);
    install_insert_text_filter(cls);
    install_insert_text_replacement_range_filter(cls);
}

unsafe fn install_key_down_probe(cls: &AnyClass) {
    let sel: Sel = sel!(keyDown:);
    let types = c"v@:@";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) = key_down_probe;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView keyDown: diagnostic probe installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct keyDown: method; keyDown diagnostic probe not installed");
    }
}

unsafe fn install_insert_text_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:);
    let types = c"v@:@";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) = insert_text_filter;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView insertText: filter installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct insertText: method; skipping legacy insertText filter");
    }
}

unsafe fn install_insert_text_replacement_range_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:replacementRange:);
    if cls.instance_method(sel).is_none() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView superclass chain does not implement insertText:replacementRange:; skipping replacementRange filter");
        return;
    }

    let types = c"v@:@{_NSRange=QQ}";
    let imp_fn: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, NSRange) =
        insert_text_replacement_range_filter;
    let imp: Imp = std::mem::transmute(imp_fn);

    let added = class_addMethod(
        (cls as *const AnyClass) as *mut AnyClass,
        sel,
        imp,
        types.as_ptr(),
    );

    if added.as_bool() {
        crate::ulog_info!("[macos_arrow_filter] WryWebView insertText:replacementRange: filter installed");
    } else {
        crate::ulog_info!("[macos_arrow_filter] WryWebView already has a direct insertText:replacementRange: method; skipping replacementRange filter");
    }
}

fn find_wry_webview_class() -> Option<&'static AnyClass> {
    // wry <= 0.54.2 used an explicit ObjC class name.
    if let Some(cls) = AnyClass::get(c"WryWebView") {
        return Some(cls);
    }

    // wry 0.54.4 removed `#[name = "WryWebView"]`. objc2 then generates a
    // version-suffixed class name such as
    // `wry::wkwebview::class::wry_web_view::WryWebView0.54.4`.
    let mut found = None;
    let mut matches = Vec::new();
    for cls in AnyClass::classes().iter().copied() {
        let name = cls.name().to_string_lossy();
        if is_wry_webview_class_name(&name) {
            matches.push(name.into_owned());
            found = Some(cls);
        }
    }

    if matches.len() > 1 {
        crate::ulog_warn!(
            "[macos_arrow_filter] multiple WryWebView-like classes found: {}; using last registered match",
            matches.join(", ")
        );
    } else if let Some(name) = matches.first() {
        crate::ulog_info!("[macos_arrow_filter] found generated WryWebView class: {name}");
    }

    found
}

fn is_wry_webview_class_name(name: &str) -> bool {
    let tail = name.rsplit("::").next().unwrap_or(name);
    if tail == "WryWebView" {
        return true;
    }
    let Some(version) = tail.strip_prefix("WryWebView") else {
        return false;
    };
    version.chars().next().is_some_and(|c| c.is_ascii_digit())
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRange {
    location: usize,
    length: usize,
}

extern "C" fn insert_text_filter(this: *mut AnyObject, _sel: Sel, insert_string: *mut AnyObject) {
    unsafe {
        log_text_if_relevant("insertText:", this, insert_string);

        if object_is_pure_function_key_text(insert_string) {
            crate::ulog_warn!(
                "[macos_arrow_filter] blocked pure function-key insertText: receiver={} text={}",
                object_class_name(this),
                describe_text_object(insert_string)
            );
            return;
        }

        let super_struct = super_struct(this);

        // objc_msgSendSuper has signature `id (struct objc_super *, SEL, ...)`
        // but we want void return on a single id arg. Cast to the right
        // signature before calling.
        type SuperInsertText = extern "C" fn(*const objc_super, Sel, *mut AnyObject);
        let send_super: SuperInsertText = std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(&super_struct, sel!(insertText:), insert_string);
    }
}

extern "C" fn insert_text_replacement_range_filter(
    this: *mut AnyObject,
    _sel: Sel,
    insert_string: *mut AnyObject,
    replacement_range: NSRange,
) {
    unsafe {
        log_text_if_relevant("insertText:replacementRange:", this, insert_string);

        if object_is_pure_function_key_text(insert_string) {
            crate::ulog_warn!(
                "[macos_arrow_filter] blocked pure function-key insertText:replacementRange: receiver={} range={}:{} text={}",
                object_class_name(this),
                replacement_range.location,
                replacement_range.length,
                describe_text_object(insert_string)
            );
            return;
        }

        let super_struct = super_struct(this);

        type SuperInsertTextReplacementRange =
            extern "C" fn(*const objc_super, Sel, *mut AnyObject, NSRange);
        let send_super: SuperInsertTextReplacementRange =
            std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(
            &super_struct,
            sel!(insertText:replacementRange:),
            insert_string,
            replacement_range,
        );
    }
}

extern "C" fn key_down_probe(this: *mut AnyObject, _sel: Sel, event: *mut AnyObject) {
    unsafe {
        let keycode: u16 = msg_send![&*event, keyCode];
        let chars: *mut AnyObject = msg_send![&*event, characters];
        let chars_ignoring_modifiers: *mut AnyObject =
            msg_send![&*event, charactersIgnoringModifiers];
        let is_arrow = (123..=126).contains(&keycode);
        let has_function_text =
            object_contains_function_key_text(chars)
                || object_contains_function_key_text(chars_ignoring_modifiers);

        if is_arrow || has_function_text {
            let modifiers: usize = msg_send![&*event, modifierFlags];
            let repeat: Bool = msg_send![&*event, isARepeat];
            crate::ulog_warn!(
                "[macos_arrow_filter] keyDown probe keycode={} repeat={} modifiers=0x{:x} receiver={} firstResponder={} chars={} charsIgnoringModifiers={}",
                keycode,
                repeat.as_bool(),
                modifiers,
                object_class_name(this),
                first_responder_class_name(this),
                describe_text_object(chars),
                describe_text_object(chars_ignoring_modifiers)
            );
        }

        let super_struct = super_struct(this);
        type SuperKeyDown = extern "C" fn(*const objc_super, Sel, *mut AnyObject);
        let send_super: SuperKeyDown = std::mem::transmute(objc_msgSendSuper as *const ());
        send_super(&super_struct, sel!(keyDown:), event);
    }
}

unsafe fn super_struct(this: *mut AnyObject) -> objc_super {
    let cls: *const AnyClass = msg_send![this, class];
    objc_super {
        receiver: this,
        super_class: class_getSuperclass(cls),
    }
}

fn class_chain(cls: &AnyClass) -> String {
    let mut names = Vec::new();
    let mut cursor = Some(cls);
    while let Some(current) = cursor {
        names.push(current.name().to_string_lossy().into_owned());
        cursor = current.superclass();
    }
    names.join(" -> ")
}

unsafe fn object_class_name(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return "nil".to_string();
    }
    let cls: *const AnyClass = msg_send![&*obj, class];
    cls.as_ref()
        .map(|c| c.name().to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

unsafe fn first_responder_class_name(view: *mut AnyObject) -> String {
    if view.is_null() {
        return "nil".to_string();
    }
    let window: *mut AnyObject = msg_send![&*view, window];
    if window.is_null() {
        return "nil-window".to_string();
    }
    let first_responder: *mut AnyObject = msg_send![&*window, firstResponder];
    object_class_name(first_responder)
}

unsafe fn log_text_if_relevant(selector: &str, receiver: *mut AnyObject, text: *mut AnyObject) {
    if object_contains_function_key_text(text) {
        crate::ulog_warn!(
            "[macos_arrow_filter] {} saw function-key text receiver={} text={}",
            selector,
            object_class_name(receiver),
            describe_text_object(text)
        );
    }
}

unsafe fn object_contains_function_key_text(obj: *mut AnyObject) -> bool {
    text_code_units(obj)
        .map(|units| units.iter().any(|ch| (0xf700..=0xf74f).contains(ch)))
        .unwrap_or(false)
}

unsafe fn object_is_pure_function_key_text(obj: *mut AnyObject) -> bool {
    let Some(units) = text_code_units(obj) else {
        return false;
    };
    !units.is_empty() && units.iter().all(|ch| (0xf700..=0xf74f).contains(ch))
}

unsafe fn text_code_units(obj: *mut AnyObject) -> Option<Vec<u16>> {
    if obj.is_null() {
        return None;
    }

    let responds_to_length: Bool = msg_send![&*obj, respondsToSelector: sel!(length)];
    let responds_to_character_at_index: Bool =
        msg_send![&*obj, respondsToSelector: sel!(characterAtIndex:)];
    if !responds_to_length.as_bool() {
        return None;
    }
    if !responds_to_character_at_index.as_bool() {
        let responds_to_string: Bool = msg_send![&*obj, respondsToSelector: sel!(string)];
        if responds_to_string.as_bool() {
            let string_obj: *mut AnyObject = msg_send![&*obj, string];
            if string_obj != obj {
                return text_code_units(string_obj);
            }
        }
        return None;
    }

    let len: usize = msg_send![&*obj, length];
    let mut units = Vec::with_capacity(len.min(64));
    for i in 0..len {
        let ch: u16 = msg_send![&*obj, characterAtIndex: i];
        units.push(ch);
    }
    Some(units)
}

unsafe fn describe_text_object(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return "nil".to_string();
    }
    let class_name = object_class_name(obj);
    match text_code_units(obj) {
        Some(units) => format!("class={} len={} units={}", class_name, units.len(), format_units(&units)),
        None => format!("class={} non-text-like", class_name),
    }
}

fn format_units(units: &[u16]) -> String {
    if units.is_empty() {
        return "[]".to_string();
    }
    let mut parts: Vec<String> = units
        .iter()
        .take(24)
        .map(|ch| format!("U+{ch:04X}"))
        .collect();
    if units.len() > 24 {
        parts.push(format!("...(+{})", units.len() - 24));
    }
    format!("[{}]", parts.join(" "))
}
