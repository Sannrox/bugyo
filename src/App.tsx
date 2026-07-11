import Fleet from "./Fleet";
import Titlebar from "./Titlebar";
import VisualReferenceFixture from "./VisualReferenceFixture";
import "./App.css";

function App() {
  const showVisualReference =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("visual-reference");

  return (
    <div className="app">
      <Titlebar />
      {showVisualReference ? <VisualReferenceFixture /> : <Fleet />}
    </div>
  );
}

export default App;
