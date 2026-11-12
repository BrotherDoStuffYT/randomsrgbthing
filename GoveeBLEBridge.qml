import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

Item {
    id: root
    anchors.fill: parent

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        Text {
            Layout.fillWidth: true
            text: "Govee BLE Bridge"
            color: theme.primarytextcolor
            font.family: theme.primaryfont
            font.pixelSize: 24
            font.weight: Font.Bold
        }

        Text {
            Layout.fillWidth: true
            text: "Link each virtual controller to add it to SignalRGB. The Python bridge must be running separately."
            color: theme.secondarytextcolor
            font.family: theme.secondaryfont
            font.pixelSize: 13
            wrapMode: Text.WordWrap
        }

        Repeater {
            model: service.controllers

            delegate: Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 82
                radius: 8
                color: "#101923"
                border.color: "#304152"
                border.width: 1

                property var target: model.modelData.obj

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 12

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 3

                        Text {
                            Layout.fillWidth: true
                            text: target.name
                            color: theme.primarytextcolor
                            font.family: theme.primaryfont
                            font.pixelSize: 16
                            font.weight: Font.Bold
                            elide: Text.ElideRight
                        }

                        Text {
                            Layout.fillWidth: true
                            text: `${target.sku} · ${target.ledCount} segments · ${target.deviceKey}`
                            color: theme.secondarytextcolor
                            font.family: theme.secondaryfont
                            font.pixelSize: 12
                            elide: Text.ElideRight
                        }
                    }

                    Button {
                        text: target.paired ? "Unlink" : "Link"
                        onClicked: target.paired ? discovery.unlink(target) : discovery.link(target)
                    }

                    Button {
                        text: "Remove"
                        onClicked: discovery.remove(target)
                    }
                }
            }
        }

        Item { Layout.fillHeight: true }

        Text {
            Layout.fillWidth: true
            text: "Bridge address: 127.0.0.1:45871 (UDP). Devices must already be powered on."
            color: theme.secondarytextcolor
            font.family: theme.secondaryfont
            font.pixelSize: 11
            wrapMode: Text.WordWrap
        }
    }
}
