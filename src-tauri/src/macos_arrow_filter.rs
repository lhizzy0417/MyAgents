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
            log::warn!("[macos_arrow_filter] wry WKWebView subclass not found; arrow-key filter not installed (leak workaround inactive)");
            return;
        }
    };

    install_insert_text_filter(cls);
    install_insert_text_replacement_range_filter(cls);
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
        log::info!("[macos_arrow_filter] WryWebView insertText: filter installed");
    } else {
        log::info!("[macos_arrow_filter] WryWebView already has a direct insertText: method; skipping legacy insertText filter");
    }
}

unsafe fn install_insert_text_replacement_range_filter(cls: &AnyClass) {
    let sel: Sel = sel!(insertText:replacementRange:);
    if cls.instance_method(sel).is_none() {
        log::info!("[macos_arrow_filter] WryWebView superclass chain does not implement insertText:replacementRange:; skipping replacementRange filter");
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
        log::info!("[macos_arrow_filter] WryWebView insertText:replacementRange: filter installed");
    } else {
        log::info!("[macos_arrow_filter] WryWebView already has a direct insertText:replacementRange: method; skipping replacementRange filter");
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
        log::warn!(
            "[macos_arrow_filter] multiple WryWebView-like classes found: {}; using last registered match",
            matches.join(", ")
        );
    } else if let Some(name) = matches.first() {
        log::info!("[macos_arrow_filter] found generated WryWebView class: {name}");
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
        if object_is_pure_function_key_text(insert_string) {
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
        if object_is_pure_function_key_text(insert_string) {
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

unsafe fn super_struct(this: *mut AnyObject) -> objc_super {
    let cls: *const AnyClass = msg_send![this, class];
    objc_super {
        receiver: this,
        super_class: class_getSuperclass(cls),
    }
}

unsafe fn object_is_pure_function_key_text(obj: *mut AnyObject) -> bool {
    if obj.is_null() {
        return false;
    }

    let responds_to_length: Bool = msg_send![&*obj, respondsToSelector: sel!(length)];
    let responds_to_character_at_index: Bool =
        msg_send![&*obj, respondsToSelector: sel!(characterAtIndex:)];
    if !responds_to_length.as_bool() {
        return false;
    }
    if !responds_to_character_at_index.as_bool() {
        let responds_to_string: Bool = msg_send![&*obj, respondsToSelector: sel!(string)];
        if responds_to_string.as_bool() {
            let string_obj: *mut AnyObject = msg_send![&*obj, string];
            return object_is_pure_function_key_text(string_obj);
        }
        return false;
    }

    let len: usize = msg_send![&*obj, length];
    if len == 0 {
        return false;
    }

    for i in 0..len {
        let ch: u16 = msg_send![&*obj, characterAtIndex: i];
        if !(0xf700..=0xf74f).contains(&ch) {
            return false;
        }
    }

    true
}
