import QtQuick
import QtQuick.Controls

ApplicationWindow {
    visible: true
    width: 640
    height: 480
    title: "QML Preview Test"

    Column {
        anchors.centerIn: parent
        spacing: 16

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Hello from QML Preview"
            font.pixelSize: 24
        }

        Button {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Click me"
            onClicked: label.text = "Clicked!"
        }

        Text {
            id: label
            anchors.horizontalCenter: parent.horizontalCenter
            text: ""
            font.pixelSize: 16
            color: "steelblue"
        }
    }
}
