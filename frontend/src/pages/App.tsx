import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './Home';
import { SmartLink } from './SmartLink';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/p/:id" element={<SmartLink />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
