---
name: pyside6
description: "[Applies to: **/*.py] Definitive guide for building modern, maintainable, and performant PySide6 applications using best practices like UI/logic separation, modern controls, and robust type safety."
source: "cursor_mdc"
---

# PySide6 Best Practices

This guide outlines the essential best practices for developing robust, maintainable, and modern PySide6 applications. Adhere to these principles to ensure high-quality, performant, and future-proof code.

## 1. Code Organization & UI Generation

**Principle:** Strictly separate UI definition from application logic. Leverage Qt Designer for visual UI creation and `pyside6-uic` for generating Python UI classes.

**Rule:** Always design your user interfaces visually in Qt Designer. Convert the `.ui` files to Python classes using `pyside6-uic`, then import and compose these generated UI classes within a dedicated Python controller class. **Never manually modify the generated `ui_*.py` files.**

❌ **BAD:** Hand-coding complex UI layouts directly in Python, or modifying generated UI files.
```python
# main.py (Bad: Hand-coding UI directly)
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton, QVBoxLayout, QWidget

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Bad UI Design - Hand-coded")
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        layout = QVBoxLayout(central_widget)
        self.button = QPushButton("Click Me")
        layout.addWidget(self.button)
        self.button.clicked.connect(self.on_button_clicked)

    def on_button_clicked(self):
        print("Button clicked!")
```

✅ **GOOD:** Use `pyside6-uic` generated UI classes composed in a controller.
```python
# 1. Design 'my_app.ui' in Qt Designer (e.g., a QMainWindow with a QPushButton named 'myButton').
# 2. Run: pyside6-uic my_app.ui -o ui_my_app.py
#
# ui_my_app.py (Generated file - DO NOT MODIFY MANUALLY)
# from PySide6 import QtCore, QtWidgets
# class Ui_MainWindow(object):
#     def setupUi(self, MainWindow):
#         MainWindow.setObjectName("MainWindow")
#         self.centralwidget = QtWidgets.QWidget(MainWindow)
#         self.myButton = QtWidgets.QPushButton(self.centralwidget)
#         self.myButton.setObjectName("myButton")
#         MainWindow.setCentralWidget(self.centralwidget)
#         self.retranslateUi(MainWindow)
#         QtCore.QMetaObject.connectSlotsByName(MainWindow)
#     def retranslateUi(self, MainWindow):
#         _translate = QtCore.QCoreApplication.translate
#         MainWindow.setWindowTitle(_translate("MainWindow", "My App"))
#         self.myButton.setText(_translate("MainWindow", "Click Me"))

# main.py (Controller class)
from PySide6.QtWidgets import QApplication, QMainWindow
from ui_my_app import Ui_MainWindow  # Import the generated UI class
import sys

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.ui = Ui_MainWindow()
        self.ui.setupUi(self)  # Initialize the UI from the generated class
        self.setWindowTitle("Good UI Design - Composed")

        # Connect signals AFTER setupUi
        self.ui.myButton.clicked.connect(self._on_button_clicked)

    def _on_button_clicked(self) -> None:
        print("Button clicked from composed UI!")

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
```

---

## 2. Modern Controls & QML

**Principle:** Embrace modern UI/UX with Qt Quick Controls 2 for fluid, material-style components. Use QML for declarative UI, and Python for business logic.

**Rule:** Prefer Qt Quick Controls 2 for new UIs. Only create custom QML controls when built-in options are insufficient. Keep QML focused on UI declaration; expose data and complex logic from Python via `QObject` properties and slots.

> **Qt6 Note:** `setContextProperty()` is deprecated. Use the `@QmlElement` decorator (preferred) or `engine.setInitialProperties()` instead.

❌ **BAD:** Mixing complex business logic directly into QML, or using the deprecated `setContextProperty()` API.
```qml
// main.qml (Bad: Complex logic in QML)
import QtQuick
import QtQuick.Controls

ApplicationWindow {
    width: 640; height: 480; visible: true
    title: "Bad QML - Logic in UI"

    TextField { id: inputField; text: "10" }
    Button {
        text: "Calculate Factorial"
        onClicked: {
            // Bad: Complex calculation directly in QML
            let n = parseInt(inputField.text)
            let result = 1
            for (let i = 2; i <= n; i++) result *= i
            resultLabel.text = "Factorial: " + result
        }
    }
    Label { id: resultLabel; text: "Result: " }
}
```

✅ **GOOD:** QML for UI, Python for logic, using the modern `@QmlElement` approach.
```python
# backend.py (Python backend registered as a QML type)
from PySide6.QtCore import QObject, Property, Signal, Slot
from PySide6.QtQml import QmlElement
import math

QML_IMPORT_NAME = "com.myapp.backend"
QML_IMPORT_MAJOR_VERSION = 1

@QmlElement
class Backend(QObject):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._input_value: str = "10"
        self._result_value: str = ""

    inputValueChanged = Signal()
    resultValueChanged = Signal()

    @Property(str, notify=inputValueChanged)
    def inputValue(self) -> str:
        return self._input_value

    @inputValue.setter
    def inputValue(self, value: str) -> None:
        if self._input_value != value:
            self._input_value = value
            self.inputValueChanged.emit()

    @Property(str, notify=resultValueChanged)
    def resultValue(self) -> str:
        return self._result_value

    @resultValue.setter
    def resultValue(self, value: str) -> None:
        if self._result_value != value:
            self._result_value = value
            self.resultValueChanged.emit()

    @Slot()
    def calculateFactorial(self) -> None:
        try:
            n = int(self.inputValue)
            if n < 0:
                self.resultValue = "Error: Negative input"
            else:
                self.resultValue = f"Factorial: {math.factorial(n)}"
        except ValueError:
            self.resultValue = "Error: Invalid number"

# main.py
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlApplicationEngine
import backend  # noqa: F401 — importing registers @QmlElement types
import sys

if __name__ == "__main__":
    app = QGuiApplication(sys.argv)
    engine = QQmlApplicationEngine()
    engine.load("main.qml")
    if not engine.rootObjects():
        sys.exit(-1)
    sys.exit(app.exec())
```

```qml
// main.qml — imports the registered QML type directly; no global context needed
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import com.myapp.backend 1.0

ApplicationWindow {
    width: 640; height: 480; visible: true
    title: "Good QML - UI Only"

    Backend { id: backend }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 20

        TextField {
            Layout.fillWidth: true
            placeholderText: "Enter a number"
            text: backend.inputValue
            onTextChanged: backend.inputValue = text
        }

        Button {
            Layout.fillWidth: true
            text: "Calculate Factorial"
            onClicked: backend.calculateFactorial()
        }

        Label {
            Layout.fillWidth: true
            text: backend.resultValue
        }
    }
}
```

---

## 3. Type Safety & Linting

**Principle:** Leverage PySide6's robust type hints for early error detection and improved code readability.

**Rule:** Always use type hints for all PySide6 properties, signals, slots, and method parameters. Enforce PEP 8 naming conventions (`snake_case` for Python functions/variables, `CamelCase` for Qt classes/methods) using `black` for formatting and `mypy`/`pylint` for static analysis in CI.

❌ **BAD:** Untyped code, inconsistent naming.
```python
# Bad: No type hints, inconsistent naming
class MyWidget(QMainWindow):
    def __init__(self):
        super().__init__()
        self.my_button = QPushButton("Click")
        self.my_button.clicked.connect(self.handle_click)

    def handle_click(self):  # Inconsistent — should be private (_handle_click)
        print("Clicked")

def AnotherFunction(arg):  # Should be another_function (snake_case)
    pass
```

✅ **GOOD:** Fully typed, PEP 8 compliant, clear intent.
```python
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton, QWidget
from PySide6.QtCore import Slot

class MyWidget(QMainWindow):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.my_button: QPushButton = QPushButton("Click Me")
        self.setCentralWidget(self.my_button)
        self.my_button.clicked.connect(self._handle_click)

    @Slot()
    def _handle_click(self) -> None:
        """Handles the button click event."""
        print("Button was clicked!")

def another_helper_function(data: str) -> bool:
    """A helper function with type hints."""
    return len(data) > 0
```

---

## 4. Styling & Theming

**Principle:** Achieve a consistent, modern UI aesthetic across your application.

**Rule:** Qt6/PySide6 handles high-DPI scaling automatically — do **not** set `AA_UseHighDpiPixmaps` (deprecated and removed in Qt 6.0). For theming, use `QtVSCodeStyle` for a VS Code-inspired look, or apply a custom stylesheet. Always use SVG icons for resolution independence.

❌ **BAD:** Setting the removed `AA_UseHighDpiPixmaps` attribute, no theming.
```python
import sys
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton
from PySide6.QtCore import Qt

app = QApplication(sys.argv)
# ❌ AA_UseHighDpiPixmaps is removed in Qt6 — do not use
app.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps)
main_win = QMainWindow()
main_win.show()
sys.exit(app.exec())
```

✅ **GOOD:** No deprecated attributes; Qt6 handles high-DPI automatically. Apply a theme.
```python
import sys
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton
import qtvscodestyle as qtvsc  # pip install qtvscodestyle

app = QApplication(sys.argv)
# Qt6 manages high-DPI automatically — no attribute needed

# Option A: VS Code-inspired theme (third-party)
stylesheet = qtvsc.load_stylesheet(qtvsc.Theme.DARK_VS)
app.setStyleSheet(stylesheet)

# Option B: Custom stylesheet (no third-party dependency)
# app.setStyleSheet("""
#     QMainWindow { background-color: #1e1e1e; }
#     QPushButton { background-color: #0e639c; color: white; border-radius: 4px; padding: 6px 12px; }
#     QPushButton:hover { background-color: #1177bb; }
# """)

main_win = QMainWindow()
push_button = QPushButton("Styled Button")
main_win.setCentralWidget(push_button)
main_win.show()
sys.exit(app.exec())
```

---

## 5. Signal/Slot Hygiene

**Principle:** Maintain clean, readable, and robust signal/slot connections.

**Rule:** Use the modern `signal.connect(slot)` syntax. Avoid lambda-heavy connections inside loops; use `functools.partial` or dedicated methods for passing arguments. Encapsulate complex slot logic in separate, well-named methods.

❌ **BAD:** Old-style connections, lambdas in loops leading to closure issues.
```python
class MyWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        layout = QVBoxLayout()
        for i in range(5):
            button = QPushButton(f"Button {i}")
            layout.addWidget(button)
            # ❌ 'i' is captured by reference — all buttons print the last value
            button.clicked.connect(lambda: self._handle_button(i))
            # ❌ Old-style Qt4 syntax — never use in PySide6
            # self.connect(button, SIGNAL("clicked()"), self._handle_button)
```

✅ **GOOD:** New-style connections, proper argument capture with `functools.partial`.
```python
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton, QVBoxLayout, QWidget
from PySide6.QtCore import Slot
from functools import partial
import sys

class MyWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        layout = QVBoxLayout(central_widget)

        for i in range(5):
            button = QPushButton(f"Button {i}")
            layout.addWidget(button)
            # ✅ partial captures 'i' by value at connection time
            button.clicked.connect(partial(self._handle_button_with_arg, i))

        self.another_button = QPushButton("Simple Action")
        layout.addWidget(self.another_button)
        self.another_button.clicked.connect(self._handle_simple_action)

    @Slot(int)
    def _handle_button_with_arg(self, index: int) -> None:
        print(f"Button {index} clicked!")

    @Slot()
    def _handle_simple_action(self) -> None:
        print("Simple action triggered!")
        self._perform_complex_sub_action()

    def _perform_complex_sub_action(self) -> None:
        print("Complex sub-action completed.")

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MyWindow()
    window.show()
    sys.exit(app.exec())
```

---

## 6. Performance & Concurrency

**Principle:** Maintain a responsive UI by offloading long-running tasks from the main thread.

**Rule:** Never perform blocking I/O (network requests, file operations, heavy computation) on the main/GUI thread. Use `QThread` with a worker `QObject` (move-to-thread pattern) or `QThreadPool` with `QRunnable`. Communicate results back to the UI exclusively via signals — never access widgets from a worker thread.

❌ **BAD:** Blocking the main thread, freezing the UI.
```python
import requests
from PySide6.QtWidgets import QApplication, QMainWindow, QPushButton, QLabel, QVBoxLayout, QWidget

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        widget = QWidget()
        self.setCentralWidget(widget)
        layout = QVBoxLayout(widget)
        self.label = QLabel("Result will appear here")
        button = QPushButton("Fetch Data")
        layout.addWidget(button)
        layout.addWidget(self.label)
        button.clicked.connect(self._fetch_data)

    def _fetch_data(self) -> None:
        # ❌ Blocks the event loop — UI freezes until the request completes
        response = requests.get("https://api.example.com/data", timeout=10)
        self.label.setText(response.json().get("value", "N/A"))
```

✅ **GOOD:** Worker thread via the move-to-thread pattern; signals carry results back.
```python
import sys
import requests
from PySide6.QtCore import QObject, QThread, Signal, Slot
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QPushButton, QLabel, QVBoxLayout, QWidget
)

class DataWorker(QObject):
    """Runs in a background thread. Never touches widgets."""
    result_ready = Signal(str)
    error_occurred = Signal(str)

    @Slot()
    def fetch(self) -> None:
        try:
            response = requests.get("https://api.example.com/data", timeout=10)
            response.raise_for_status()
            value = response.json().get("value", "N/A")
            self.result_ready.emit(value)
        except Exception as exc:
            self.error_occurred.emit(str(exc))


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        widget = QWidget()
        self.setCentralWidget(widget)
        layout = QVBoxLayout(widget)

        self.label = QLabel("Result will appear here")
        self.button = QPushButton("Fetch Data")
        layout.addWidget(self.button)
        layout.addWidget(self.label)

        # Set up worker and thread
        self._thread = QThread(self)
        self._worker = DataWorker()
        self._worker.moveToThread(self._thread)

        # Wire signals
        self.button.clicked.connect(self._start_fetch)
        self._worker.result_ready.connect(self._on_result)
        self._worker.error_occurred.connect(self._on_error)
        self._thread.start()

    def _start_fetch(self) -> None:
        self.button.setEnabled(False)
        self.label.setText("Loading…")
        # ✅ Invoke slot on the worker's thread via signal or QMetaObject
        QThread.currentThread()  # stays on GUI thread
        self._worker.fetch.__call__()  # triggers via event loop on worker thread

    @Slot(str)
    def _on_result(self, value: str) -> None:
        self.label.setText(value)
        self.button.setEnabled(True)

    @Slot(str)
    def _on_error(self, message: str) -> None:
        self.label.setText(f"Error: {message}")
        self.button.setEnabled(True)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self._thread.quit()
        self._thread.wait()
        super().closeEvent(event)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
```

> **Tip:** For fire-and-forget parallel tasks (e.g. thumbnail generation), use `QThreadPool` + `QRunnable` instead of a persistent `QThread`.

---

## Quick Reference: Common Pitfalls

| Pitfall | Fix |
|---|---|
| `AA_UseHighDpiPixmaps` | Removed in Qt6 — delete it; high-DPI is automatic |
| `setContextProperty()` in QML | Use `@QmlElement` decorator instead |
| Lambda in loop captures loop var | Use `functools.partial` to bind value at connection time |
| Old-style `SIGNAL()`/`SLOT()` | Use `object.signal.connect(slot)` syntax |
| Blocking I/O on main thread | Move to `QThread` worker; return results via signals |
| Modifying generated `ui_*.py` | Never — re-run `pyside6-uic` instead |
| Unicode bullet characters in widgets | Use `LevelFormat.BULLET` numbering config |
